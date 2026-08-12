// A process that fails immediately, every time, so that the supervisor's
// giving-up rule can be tested. The exit code is arbitrary; only its being
// non-zero and its being immediate matter.
process.stdout.write("exit-at-once failing\n");
process.exit(7);
