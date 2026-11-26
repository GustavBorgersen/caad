// Where the site's own files are: the folder index.html is served from. CAAD can be hosted anywhere (the
// release bundle on a company web server, e.g. http://intranet/caad/), so nothing assumes it is at "/".

/** The site's root URL, ending in "/". In the kernel worker it is passed in as the worker's name. */
export const SITE_ROOT: string = typeof document !== "undefined" ? new URL(".", document.baseURI).href : self.name;

/** URL of one of the site's files: `siteUrl("kernel/wheels/x.whl")`. */
export const siteUrl = (path: string) => new URL(path.replace(/^\//, ""), SITE_ROOT).href;
