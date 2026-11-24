// caad-mcp: the bridge between an MCP client (Claude Code, Claude Desktop, ...) and the CAAD web page.
//
// The agent starts this program and talks MCP to it over stdin/stdout. The CAAD page connects to it
// over a WebSocket on 127.0.0.1. Every tool call is passed to the page, which does the work (it runs
// build123d) and answers. The bridge itself reads no files and runs no code.
package main

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	version     = "0.1.0"
	firstPort   = 7337
	portCount   = 10
	callTimeout = 120 * time.Second
)

//go:embed tools.json
var embeddedTools []byte

//go:embed instructions.md
var instructions string

var supportedProtocols = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

// --- MCP side (stdin/stdout, newline-delimited JSON-RPC) -------------------------------------

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type bridge struct {
	out     *json.Encoder
	outMu   sync.Mutex
	origins []string
	mu      sync.Mutex
	page    *pageConn
	tools   json.RawMessage
	client  string
	ready   bool // MCP client finished initialising (may receive notifications)
	pageURL string
}

func (b *bridge) send(m rpcMessage) {
	m.JSONRPC = "2.0"
	b.outMu.Lock()
	defer b.outMu.Unlock()
	if err := b.out.Encode(m); err != nil {
		log.Printf("write to client: %v", err)
	}
}

func (b *bridge) reply(id json.RawMessage, result any) { b.send(rpcMessage{ID: id, Result: result}) }
func (b *bridge) fail(id json.RawMessage, code int, msg string) {
	b.send(rpcMessage{ID: id, Error: &rpcError{Code: code, Message: msg}})
}

func textResult(text string, isError bool) map[string]any {
	return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": isError}
}

func (b *bridge) handle(m rpcMessage) {
	if m.ID == nil { // notification: nothing to answer
		if m.Method == "notifications/initialized" {
			b.mu.Lock()
			b.ready = true
			b.mu.Unlock()
		}
		return
	}
	switch m.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
			ClientInfo      struct {
				Name string `json:"name"`
			} `json:"clientInfo"`
		}
		_ = json.Unmarshal(m.Params, &p)
		proto := supportedProtocols[1]
		for _, v := range supportedProtocols {
			if v == p.ProtocolVersion {
				proto = v
			}
		}
		b.mu.Lock()
		b.client = p.ClientInfo.Name
		b.mu.Unlock()
		b.reply(m.ID, map[string]any{
			"protocolVersion": proto,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": true}},
			"serverInfo":      map[string]any{"name": "caad", "version": version},
			"instructions":    instructions,
		})
	case "ping":
		b.reply(m.ID, map[string]any{})
	case "tools/list":
		b.mu.Lock()
		tools := b.tools
		b.mu.Unlock()
		b.reply(m.ID, map[string]any{"tools": tools})
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(m.Params, &p); err != nil {
			b.fail(m.ID, -32602, "invalid params")
			return
		}
		go b.callTool(m.ID, p.Name, p.Arguments)
	default:
		b.fail(m.ID, -32601, "method not found: "+m.Method)
	}
}

func (b *bridge) callTool(id json.RawMessage, name string, args json.RawMessage) {
	b.mu.Lock()
	page := b.page
	b.mu.Unlock()
	if page == nil {
		if name == "get_status" {
			b.reply(id, textResult(fmt.Sprintf("CAAD bridge %s is running, but no CAAD page is connected. Ask the user to open the CAAD page in Chrome or Edge and open a project; it connects automatically.", version), false))
			return
		}
		b.reply(id, textResult("No CAAD page is connected. Ask the user to open the CAAD page in Chrome or Edge; it connects automatically.", true))
		return
	}
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	result, err := page.call(name, args)
	if err != nil {
		b.reply(id, textResult(err.Error(), true))
		return
	}
	b.reply(id, result)
}

// --- Page side (WebSocket on 127.0.0.1) -----------------------------------------------------------

type pageConn struct {
	ws      *websocket.Conn
	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  int
	waiting map[int]chan pageReply
}

type pageReply struct {
	Result json.RawMessage
	Error  string
}

func (p *pageConn) write(v any) error {
	data, _ := json.Marshal(v)
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return p.ws.Write(ctx, websocket.MessageText, data)
}

func (p *pageConn) call(name string, args json.RawMessage) (json.RawMessage, error) {
	p.mu.Lock()
	p.nextID++
	id := p.nextID
	ch := make(chan pageReply, 1)
	p.waiting[id] = ch
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.waiting, id); p.mu.Unlock() }()
	if err := p.write(map[string]any{"type": "call", "id": id, "name": name, "arguments": args}); err != nil {
		return nil, fmt.Errorf("could not reach the CAAD page: %v", err)
	}
	select {
	case r := <-ch:
		if r.Error != "" {
			return nil, errors.New(r.Error)
		}
		return r.Result, nil
	case <-time.After(callTimeout):
		return nil, fmt.Errorf("the CAAD page did not answer %s within %s", name, callTimeout)
	}
}

func (b *bridge) serveWS(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: b.origins})
	if err != nil {
		log.Printf("rejected connection from origin %q: %v", r.Header.Get("Origin"), err)
		return
	}
	ws.SetReadLimit(64 << 20) // renders and big parts
	page := &pageConn{ws: ws, waiting: map[int]chan pageReply{}}
	log.Printf("page connected from %s", r.Header.Get("Origin"))

	b.mu.Lock()
	b.page = page // the newest page wins
	b.pageURL = r.Header.Get("Origin")
	client := b.client
	b.mu.Unlock()
	_ = page.write(map[string]any{"type": "hello", "bridge": version, "agent": client})

	for {
		_, data, err := ws.Read(context.Background())
		if err != nil {
			break
		}
		var msg struct {
			Type   string          `json:"type"`
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  string          `json:"error"`
			Tools  json.RawMessage `json:"tools"`
		}
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "result":
			page.mu.Lock()
			ch := page.waiting[msg.ID]
			page.mu.Unlock()
			if ch != nil {
				ch <- pageReply{Result: msg.Result, Error: msg.Error}
			}
		case "hello":
			// The page brings its own tool list: a newer page may have more tools than this bridge knows.
			if len(msg.Tools) > 0 {
				b.mu.Lock()
				changed := string(b.tools) != string(msg.Tools)
				b.tools = msg.Tools
				ready := b.ready
				b.mu.Unlock()
				if changed && ready {
					b.send(rpcMessage{Method: "notifications/tools/list_changed"})
				}
			}
		}
	}
	b.mu.Lock()
	if b.page == page {
		b.page = nil
	}
	b.mu.Unlock()
	log.Printf("page disconnected")
}

func listen() (net.Listener, error) {
	for port := firstPort; port < firstPort+portCount; port++ {
		if l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port)); err == nil {
			return l, nil
		}
	}
	return nil, fmt.Errorf("ports %d-%d are all in use", firstPort, firstPort+portCount-1)
}

// originPatterns turns allowed origins (https://caad.example.com) into host patterns for websocket.Accept.
func originPatterns(allowed []string) []string {
	patterns := []string{"127.0.0.1:*", "localhost:*", "127.0.0.1", "localhost"}
	for _, a := range allowed {
		for _, o := range strings.Split(a, ",") {
			o = strings.TrimSpace(o)
			if o == "" {
				continue
			}
			if u, err := url.Parse(o); err == nil && u.Host != "" {
				o = u.Host
			}
			patterns = append(patterns, o)
		}
	}
	return patterns
}

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	var allowed multiFlag
	flag.Var(&allowed, "allow-origin", "CAAD site allowed to connect, e.g. https://caad.example.com (repeatable; localhost is always allowed)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("caad-mcp", version)
		return
	}
	if env := os.Getenv("CAAD_ALLOW_ORIGIN"); env != "" {
		allowed = append(allowed, env)
	}
	log.SetFlags(0)
	log.SetPrefix("[caad-mcp] ") // stderr: stdout belongs to MCP

	b := &bridge{out: json.NewEncoder(os.Stdout), origins: originPatterns(allowed), tools: embeddedTools}

	l, err := listen()
	if err != nil {
		log.Printf("%v; the page cannot connect, tools will report this", err)
	} else {
		log.Printf("waiting for the CAAD page on ws://%s", l.Addr())
		go func() { _ = http.Serve(l, http.HandlerFunc(b.serveWS)) }()
	}

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1<<20), 64<<20)
	for in.Scan() {
		line := in.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var msgs []rpcMessage
		if line[0] == '[' {
			_ = json.Unmarshal(line, &msgs)
		} else {
			var m rpcMessage
			if json.Unmarshal(line, &m) == nil {
				msgs = append(msgs, m)
			}
		}
		for _, m := range msgs {
			b.handle(m)
		}
	}
}
