// Express 4 doesn't await async route handlers, so a rejected promise from
// one never reaches next(err) or the error middleware — it becomes an
// unhandled rejection instead, which crashes the whole process on modern
// Node. Wrap every async handler with this so failures route through
// Express's normal error handling.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
