// A process that does nothing except keep running, so that the supervisor can
// be tested without loreserver. It announces itself on stdout — which is how a
// test can tell that output reached the log file — and then holds the event
// loop open with a timer until something else ends it.
process.stdout.write(`stay-alive ${process.pid} running\n`);
setInterval(() => {}, 60_000);
