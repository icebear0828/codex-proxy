/**
 * Thin wrapper for libcurl-impersonate symbols.
 *
 * The pre-built static library (.a) has hidden visibility on all symbols.
 * This wrapper creates exported (default visibility) functions that forward
 * to the hidden symbols, allowing koffi FFI to bind them at runtime.
 *
 * Used by: setup-curl.ts (local build) and build-curl-libs.yml (CI build).
 */
#include <stddef.h>
#define VIS __attribute__((visibility("default")))

extern void *curl_easy_init(void);
extern void curl_easy_cleanup(void *);
extern int curl_easy_setopt(void *, int, ...);
extern int curl_easy_getinfo(void *, int, ...);
extern int curl_easy_perform(void *);
extern int curl_easy_impersonate(void *, const char *, int);
extern void *curl_slist_append(void *, const char *);
extern void curl_slist_free_all(void *);
extern void *curl_multi_init(void);
extern int curl_multi_add_handle(void *, void *);
extern int curl_multi_remove_handle(void *, void *);
extern int curl_multi_perform(void *, int *);
extern int curl_multi_poll(void *, void *, int, int, int *);
extern int curl_multi_cleanup(void *);
extern void *curl_share_init(void);
extern int curl_share_setopt(void *, int, ...);
extern int curl_share_cleanup(void *);
extern int curl_global_init(int);
extern void curl_global_cleanup(void);

VIS void *w_curl_easy_init(void) { return curl_easy_init(); }
VIS void w_curl_easy_cleanup(void *h) { curl_easy_cleanup(h); }
VIS int w_curl_easy_perform(void *h) { return curl_easy_perform(h); }
VIS int w_curl_easy_impersonate(void *h, const char *t, int d) { return curl_easy_impersonate(h, t, d); }
VIS void *w_curl_slist_append(void *s, const char *str) { return curl_slist_append(s, str); }
VIS void w_curl_slist_free_all(void *s) { curl_slist_free_all(s); }
VIS void *w_curl_multi_init(void) { return curl_multi_init(); }
VIS int w_curl_multi_add_handle(void *m, void *e) { return curl_multi_add_handle(m, e); }
VIS int w_curl_multi_remove_handle(void *m, void *e) { return curl_multi_remove_handle(m, e); }
VIS int w_curl_multi_perform(void *m, int *r) { return curl_multi_perform(m, r); }
VIS int w_curl_multi_poll(void *m, void *e, int n, int t, int *f) { return curl_multi_poll(m, e, n, t, f); }
VIS int w_curl_multi_cleanup(void *m) { return curl_multi_cleanup(m); }
VIS void *w_curl_share_init(void) { return curl_share_init(); }
VIS int w_curl_share_cleanup(void *s) { return curl_share_cleanup(s); }
VIS int w_curl_global_init(int f) { return curl_global_init(f); }
VIS void w_curl_global_cleanup(void) { curl_global_cleanup(); }

VIS int w_curl_easy_setopt_long(void *h, int opt, long val) { return curl_easy_setopt(h, opt, val); }
VIS int w_curl_easy_setopt_str(void *h, int opt, const char *val) { return curl_easy_setopt(h, opt, val); }
VIS int w_curl_easy_setopt_ptr(void *h, int opt, void *val) { return curl_easy_setopt(h, opt, val); }
VIS int w_curl_easy_setopt_cb(void *h, int opt, void *cb) { return curl_easy_setopt(h, opt, cb); }
VIS int w_curl_easy_getinfo_long(void *h, int info, int *val) { return curl_easy_getinfo(h, info, val); }
VIS int w_curl_share_setopt_long(void *s, int opt, long val) { return curl_share_setopt(s, opt, val); }
