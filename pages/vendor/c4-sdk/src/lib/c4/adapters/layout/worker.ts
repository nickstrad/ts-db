// ELK's native worker entry installs its supported message handler in this dedicated
// worker. Do not use elk.bundled here: its fake-worker factory targets the window/Node
// environment. The client uses elk-api's official workerFactory to drive this entry.
import "elkjs/lib/elk-worker.min.js";
