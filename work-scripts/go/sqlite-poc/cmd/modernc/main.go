// modernc.org/sqlite: the SQLite C source transpiled to Go, no cgo. A statement runs as ordinary
// Go code on a goroutine, so the scheduler can preempt it; cancellation is whatever the driver
// implements on top of the transpiled sqlite3_interrupt.
package main

import (
	_ "modernc.org/sqlite"

	"tsdb/work-scripts/sqlite-poc/harness"
)

func main() {
	harness.Run("sqlite", func(path string) string {
		return "file:" + path + "?_pragma=busy_timeout(5000)"
	})
}
