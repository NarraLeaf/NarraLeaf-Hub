// Stands in for react-devtools-core in the bundle.
//
// Ink imports it at the top of a module rather than behind the check that
// decides whether to connect to a debugger, so leaving it external puts an
// import of a package nobody installed into the finished executable, and the
// program dies with ERR_MODULE_NOT_FOUND before it draws anything. Bundling
// the real thing would carry a websocket client and the whole devtools
// backend into a program that never connects to one.
export default {
  connectToDevTools() {},
};
