// Package harness measures, for one Go SQLite driver, the three things the lang-switch brief asks
// about: whether a long statement on one tenant file blocks reads on other tenant files (the Deno
// event-loop problem), how fast a running statement can be cancelled through context (the
// worker.terminate() problem), and what one connection costs in OS threads and file descriptors.
//
// It is driver-agnostic: cmd/mattn, cmd/modernc and cmd/ncruces import their driver and call Run
// with the database/sql driver name and a DSN builder. Output is one JSON object on stdout.
package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A recursive CTE of this depth runs for tens of seconds under stock SQLite; the harness never
// lets it finish, it cancels it. Tune LONG_ROWS if the host is much faster or slower.
const defaultLongRows = 400_000_000

const tenants = 32

type Percentiles struct {
	Samples int     `json:"samples"`
	P50ms   float64 `json:"p50_ms"`
	P99ms   float64 `json:"p99_ms"`
	Maxms   float64 `json:"max_ms"`
}

type Window struct {
	LongQueries     int         `json:"long_queries"`
	Reads           Percentiles `json:"reads_on_other_tenants"`
	ThreadsBefore   int         `json:"os_threads_before"`
	ThreadsPeak     int         `json:"os_threads_peak"`
	CancelLatencyMs []float64   `json:"cancel_latency_ms"`
	CancelErrors    []string    `json:"cancel_errors"`
}

type Result struct {
	Driver            string      `json:"driver"`
	GoVersion         string      `json:"go_version"`
	GOMAXPROCS        int         `json:"gomaxprocs"`
	Tenants           int         `json:"tenants"`
	FdsPerConnection  float64     `json:"fds_per_open_connection"`
	Baseline          Percentiles `json:"baseline_reads"`
	SingleCancelMs    float64     `json:"single_cancel_latency_ms"`
	SingleCancelError string      `json:"single_cancel_error"`
	Windows           []Window    `json:"windows"`
	Notes             []string    `json:"notes"`
}

func percentiles(samples []float64) Percentiles {
	if len(samples) == 0 {
		return Percentiles{}
	}
	sort.Float64s(samples)
	at := func(p float64) float64 {
		i := int(p*float64(len(samples))+0.999999) - 1
		if i < 0 {
			i = 0
		}
		if i >= len(samples) {
			i = len(samples) - 1
		}
		return samples[i]
	}
	return Percentiles{Samples: len(samples), P50ms: at(0.50), P99ms: at(0.99), Maxms: samples[len(samples)-1]}
}

func osThreads() int {
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return -1
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "Threads:") {
			n, _ := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "Threads:")))
			return n
		}
	}
	return -1
}

func openFds() int {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return -1
	}
	return len(entries)
}

func must(err error, what string) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: %v\n", what, err)
		os.Exit(1)
	}
}

func longRows() int {
	if v := os.Getenv("LONG_ROWS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return defaultLongRows
}

func longQuery() string {
	return fmt.Sprintf("WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < %d) SELECT count(*) FROM c", longRows())
}

// readLoop hammers point reads on tenants [from, to) with `workers` goroutines until deadline.
func readLoop(dbs []*sql.DB, from, to, workers int, d time.Duration) Percentiles {
	var mu sync.Mutex
	var all []float64
	var wg sync.WaitGroup
	deadline := time.Now().Add(d)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(seed int64) {
			defer wg.Done()
			r := rand.New(rand.NewSource(seed))
			var local []float64
			for time.Now().Before(deadline) {
				db := dbs[from+r.Intn(to-from)]
				id := 1 + r.Intn(1000)
				t := time.Now()
				var body string
				err := db.QueryRow("SELECT body FROM docs WHERE id = ?", id).Scan(&body)
				local = append(local, float64(time.Since(t).Nanoseconds())/1e6)
				if err != nil {
					fmt.Fprintf(os.Stderr, "read error: %v\n", err)
				}
			}
			mu.Lock()
			all = append(all, local...)
			mu.Unlock()
		}(int64(w))
	}
	wg.Wait()
	return percentiles(all)
}

// startLong runs the long query on db under ctx in its own goroutine and reports, on done, the
// time between cancel() being called and the query returning, plus the error text.
func startLong(ctx context.Context, db *sql.DB, q string) (cancel func(), done <-chan [2]string) {
	ctx, c := context.WithCancel(ctx)
	ch := make(chan [2]string, 1)
	var cancelledAt time.Time
	var once sync.Once
	cancel = func() {
		once.Do(func() {
			cancelledAt = time.Now()
			c()
		})
	}
	go func() {
		var n int64
		err := db.QueryRowContext(ctx, q).Scan(&n)
		lat := "nan"
		if !cancelledAt.IsZero() {
			lat = strconv.FormatFloat(float64(time.Since(cancelledAt).Nanoseconds())/1e6, 'f', 3, 64)
		}
		msg := "nil"
		if err != nil {
			msg = err.Error()
		}
		ch <- [2]string{lat, msg}
	}()
	return cancel, ch
}

// Run executes the experiment for one driver and prints JSON.
func Run(driver string, dsn func(path string) string) {
	dir, err := os.MkdirTemp("", "sqlite-poc-"+driver+"-")
	must(err, "mkdtemp")
	defer os.RemoveAll(dir)

	res := Result{Driver: driver, GoVersion: runtime.Version(), GOMAXPROCS: runtime.GOMAXPROCS(0), Tenants: tenants}

	// Create tenant files with a dedicated connection each, WAL mode, 1000 rows.
	fdBefore := openFds()
	dbs := make([]*sql.DB, tenants)
	for i := range dbs {
		path := filepath.Join(dir, fmt.Sprintf("t%02d.db", i))
		db, err := sql.Open(driver, dsn(path))
		must(err, "open")
		db.SetMaxOpenConns(2)
		db.SetMaxIdleConns(2)
		_, err = db.Exec("PRAGMA journal_mode=WAL")
		must(err, "wal")
		_, err = db.Exec("CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT)")
		must(err, "ddl")
		tx, err := db.Begin()
		must(err, "begin")
		for id := 1; id <= 1000; id++ {
			_, err = tx.Exec("INSERT INTO docs(id, body) VALUES (?, ?)", id, strings.Repeat("x", 200))
			must(err, "insert")
		}
		must(tx.Commit(), "commit")
		dbs[i] = db
	}
	// Each pool now holds exactly one idle connection (the one that ran setup).
	res.FdsPerConnection = float64(openFds()-fdBefore) / float64(tenants)

	// Baseline reads with nothing else running.
	res.Baseline = readLoop(dbs, 8, tenants, 8, 2*time.Second)

	// Single long query, cancelled after 500 ms: the cleanest interrupt-latency number.
	q := longQuery()
	cancel, done := startLong(context.Background(), dbs[0], q)
	time.Sleep(500 * time.Millisecond)
	cancel()
	r := <-done
	res.SingleCancelMs, _ = strconv.ParseFloat(r[0], 64)
	res.SingleCancelError = r[1]

	// Windows: K long queries on tenants 0..K-1 while 8 goroutines read tenants 8..31 for 3 s.
	for _, k := range []int{1, 2, 4, 8} {
		w := Window{LongQueries: k, ThreadsBefore: osThreads()}
		cancels := make([]func(), k)
		dones := make([]<-chan [2]string, k)
		for i := 0; i < k; i++ {
			cancels[i], dones[i] = startLong(context.Background(), dbs[i], q)
		}
		time.Sleep(200 * time.Millisecond)
		w.ThreadsPeak = osThreads()
		w.Reads = readLoop(dbs, 8, tenants, 8, 3*time.Second)
		if t := osThreads(); t > w.ThreadsPeak {
			w.ThreadsPeak = t
		}
		for i := 0; i < k; i++ {
			cancels[i]()
		}
		for i := 0; i < k; i++ {
			r := <-dones[i]
			ms, _ := strconv.ParseFloat(r[0], 64)
			w.CancelLatencyMs = append(w.CancelLatencyMs, ms)
			w.CancelErrors = append(w.CancelErrors, r[1])
		}
		res.Windows = append(res.Windows, w)
	}

	res.Notes = append(res.Notes,
		"reads_on_other_tenants: 8 goroutines doing point reads on tenants 8..31 while K long recursive-CTE statements run on tenants 0..K-1",
		"cancel_latency_ms: time from context cancel to QueryRowContext returning; a value in the thousands means the statement ran to completion",
		fmt.Sprintf("host: %d CPUs; LONG_ROWS=%d", runtime.NumCPU(), longRows()),
	)
	for _, db := range dbs {
		db.Close()
	}
	enc := json.NewEncoder(os.Stdout)
	must(enc.Encode(res), "encode")
}
