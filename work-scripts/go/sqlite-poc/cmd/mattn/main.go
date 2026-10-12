// mattn/go-sqlite3: cgo binding over the bundled SQLite amalgamation. Each statement is a cgo
// call that pins an OS thread for its duration; context cancellation calls sqlite3_interrupt.
package main

import (
	_ "github.com/mattn/go-sqlite3"

	"tsdb/work-scripts/sqlite-poc/harness"
)

func main() {
	harness.Run("sqlite3", func(path string) string {
		return "file:" + path + "?_busy_timeout=5000"
	})
}
