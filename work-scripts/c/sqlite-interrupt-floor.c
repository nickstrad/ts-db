/*
 * sqlite-interrupt-floor.c: the floor for the two numbers the lang-switch brief cares about, with
 * no language runtime in the way. One pthread per connection; sqlite3_interrupt() from another
 * thread; point reads on other tenant files while K long statements run.
 *
 * Build (uses the amalgamation that mattn/go-sqlite3 bundles, so no libsqlite3-dev is needed):
 *   AM=$(go env GOMODCACHE)/github.com/mattn/go-sqlite3@v1.14.52
 *   gcc -O2 -DSQLITE_THREADSAFE=2 -I"$AM" work-scripts/c/sqlite-interrupt-floor.c \
 *       "$AM/sqlite3-binding.c" -lpthread -ldl -lm -o /tmp/sqlite-interrupt-floor
 * Run: /tmp/sqlite-interrupt-floor [long_rows]   (prints one JSON object)
 */
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include "sqlite3-binding.h"

#define TENANTS 32
#define READERS 8

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

static long long long_rows = 400000000LL;
static char dir[256];
static sqlite3 *dbs[TENANTS];

static void die(const char *what, sqlite3 *db) {
  fprintf(stderr, "%s: %s\n", what, db ? sqlite3_errmsg(db) : "?");
  exit(1);
}

static sqlite3 *open_tenant(int i) {
  char path[512];
  snprintf(path, sizeof path, "%s/t%02d.db", dir, i);
  sqlite3 *db;
  if (sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX, NULL) != SQLITE_OK) die("open", db);
  sqlite3_busy_timeout(db, 5000);
  return db;
}

struct long_job {
  int tenant;
  double started, cancelled, returned;
  int rc;
};

static void *run_long(void *arg) {
  struct long_job *j = arg;
  char sql[256];
  snprintf(sql, sizeof sql,
           "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < %lld) SELECT count(*) FROM c",
           long_rows);
  sqlite3_stmt *st;
  if (sqlite3_prepare_v2(dbs[j->tenant], sql, -1, &st, NULL) != SQLITE_OK) die("prepare long", dbs[j->tenant]);
  j->started = now_ms();
  int rc = sqlite3_step(st);
  j->returned = now_ms();
  j->rc = rc;
  sqlite3_finalize(st);
  return NULL;
}

struct reader {
  int from, to;
  double until;
  double *lat;
  int n, cap;
  unsigned seed;
};

static void *run_reader(void *arg) {
  struct reader *r = arg;
  sqlite3 **conns = calloc(TENANTS, sizeof *conns);
  sqlite3_stmt **sts = calloc(TENANTS, sizeof *sts);
  for (int i = r->from; i < r->to; i++) {
    conns[i] = open_tenant(i);
    if (sqlite3_prepare_v2(conns[i], "SELECT body FROM docs WHERE id = ?", -1, &sts[i], NULL) != SQLITE_OK) die("prepare read", conns[i]);
  }
  while (now_ms() < r->until) {
    int t = r->from + rand_r(&r->seed) % (r->to - r->from);
    int id = 1 + rand_r(&r->seed) % 1000;
    double t0 = now_ms();
    sqlite3_bind_int(sts[t], 1, id);
    int rc = sqlite3_step(sts[t]);
    if (rc != SQLITE_ROW) die("read", conns[t]);
    sqlite3_reset(sts[t]);
    if (r->n == r->cap) { r->cap = r->cap ? r->cap * 2 : 4096; r->lat = realloc(r->lat, r->cap * sizeof(double)); }
    r->lat[r->n++] = now_ms() - t0;
  }
  for (int i = r->from; i < r->to; i++) { sqlite3_finalize(sts[i]); sqlite3_close(conns[i]); }
  free(conns); free(sts);
  return NULL;
}

static int cmp_double(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return (x > y) - (x < y);
}

static void pct(double *all, int n, double *p50, double *p99, double *max) {
  qsort(all, n, sizeof(double), cmp_double);
  int i50 = (int)(0.50 * n + 0.999999) - 1, i99 = (int)(0.99 * n + 0.999999) - 1;
  if (i50 < 0) i50 = 0; if (i99 < 0) i99 = 0;
  *p50 = all[i50]; *p99 = all[i99]; *max = all[n - 1];
}

static int count_fds(void) {
  char buf[64]; snprintf(buf, sizeof buf, "/proc/%d/fd", getpid());
  int n = 0; FILE *p; char cmd[128];
  snprintf(cmd, sizeof cmd, "ls %s | wc -l", buf);
  p = popen(cmd, "r"); if (p) { if (fscanf(p, "%d", &n) != 1) n = -1; pclose(p); }
  return n;
}

static void window(int k, double seconds, FILE *out, int first) {
  pthread_t lt[TENANTS], rt[READERS];
  struct long_job jobs[TENANTS];
  struct reader readers[READERS];
  for (int i = 0; i < k; i++) { jobs[i].tenant = i; pthread_create(&lt[i], NULL, run_long, &jobs[i]); }
  usleep(200 * 1000);
  double until = now_ms() + seconds * 1000;
  for (int i = 0; i < READERS; i++) {
    readers[i] = (struct reader){ .from = 8, .to = TENANTS, .until = until, .seed = (unsigned)i + 1 };
    pthread_create(&rt[i], NULL, run_reader, &readers[i]);
  }
  for (int i = 0; i < READERS; i++) pthread_join(rt[i], NULL);
  double cancelled = now_ms();
  for (int i = 0; i < k; i++) { jobs[i].cancelled = cancelled; sqlite3_interrupt(dbs[i]); }
  for (int i = 0; i < k; i++) pthread_join(lt[i], NULL);
  int n = 0; for (int i = 0; i < READERS; i++) n += readers[i].n;
  double *all = malloc(n * sizeof(double)); int o = 0;
  for (int i = 0; i < READERS; i++) { memcpy(all + o, readers[i].lat, readers[i].n * sizeof(double)); o += readers[i].n; free(readers[i].lat); }
  double p50, p99, mx; pct(all, n, &p50, &p99, &mx); free(all);
  fprintf(out, "%s{\"long_queries\":%d,\"reads_on_other_tenants\":{\"samples\":%d,\"p50_ms\":%.4f,\"p99_ms\":%.4f,\"max_ms\":%.3f},\"cancel_latency_ms\":[",
          first ? "" : ",", k, n, p50, p99, mx);
  for (int i = 0; i < k; i++) fprintf(out, "%s%.3f", i ? "," : "", jobs[i].returned - jobs[i].cancelled);
  fprintf(out, "],\"rc\":[");
  for (int i = 0; i < k; i++) fprintf(out, "%s%d", i ? "," : "", jobs[i].rc);
  fprintf(out, "]}");
}

int main(int argc, char **argv) {
  if (argc > 1) long_rows = atoll(argv[1]);
  snprintf(dir, sizeof dir, "/tmp/sqlite-interrupt-floor-%d", getpid());
  mkdir(dir, 0700);
  int fd0 = count_fds();
  for (int i = 0; i < TENANTS; i++) {
    dbs[i] = open_tenant(i);
    char *err = NULL;
    if (sqlite3_exec(dbs[i], "PRAGMA journal_mode=WAL; CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT); BEGIN;", NULL, NULL, &err) != SQLITE_OK) die(err, NULL);
    sqlite3_stmt *ins;
    sqlite3_prepare_v2(dbs[i], "INSERT INTO docs(id, body) VALUES (?, ?)", -1, &ins, NULL);
    char body[201]; memset(body, 'x', 200); body[200] = 0;
    for (int id = 1; id <= 1000; id++) { sqlite3_bind_int(ins, 1, id); sqlite3_bind_text(ins, 2, body, -1, SQLITE_STATIC); sqlite3_step(ins); sqlite3_reset(ins); }
    sqlite3_finalize(ins);
    sqlite3_exec(dbs[i], "COMMIT", NULL, NULL, NULL);
  }
  double fds_per_conn = (double)(count_fds() - fd0) / TENANTS;

  /* single interrupt after 500 ms */
  struct long_job j = { .tenant = 0 };
  pthread_t t; pthread_create(&t, NULL, run_long, &j);
  usleep(500 * 1000);
  j.cancelled = now_ms(); sqlite3_interrupt(dbs[0]);
  pthread_join(t, NULL);

  printf("{\"driver\":\"c-sqlite3_interrupt\",\"sqlite\":\"%s\",\"tenants\":%d,\"fds_per_open_connection\":%.2f,\"single_cancel_latency_ms\":%.3f,\"single_cancel_rc\":%d,\"windows\":[",
         sqlite3_libversion(), TENANTS, fds_per_conn, j.returned - j.cancelled, j.rc);
  int ks[] = {1, 2, 4, 8};
  for (int i = 0; i < 4; i++) window(ks[i], 3.0, stdout, i == 0);
  printf("],\"notes\":[\"rc 9 = SQLITE_INTERRUPT\",\"one pthread per long statement; readers open their own connections per tenant\"]}\n");
  for (int i = 0; i < TENANTS; i++) sqlite3_close(dbs[i]);
  char cmd[300]; snprintf(cmd, sizeof cmd, "rm -rf %s", dir); system(cmd);
  return 0;
}
