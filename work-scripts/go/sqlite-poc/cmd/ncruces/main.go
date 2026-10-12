// ncruces/go-sqlite3: SQLite compiled to WebAssembly and translated to Go (wasm2go), no cgo. Each
// connection runs in its own sandbox; context cancellation goes through SetInterrupt.
package main

import (
	_ "github.com/ncruces/go-sqlite3/driver"

	"tsdb/work-scripts/sqlite-poc/harness"
)

func main() {
	harness.Run("sqlite3", func(path string) string {
		return "file:" + path + "?_pragma=busy_timeout(5000)"
	})
}
