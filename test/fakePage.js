// Minimal stand-in for a Playwright page: records navigations, and lets a test decide where a
// goto actually lands (e.g. a /login redirect) and what page.evaluate returns.
function fakePage({ redirect = (url) => url, evaluate = async () => null } = {}) {
  const page = {
    visited: [],
    current: 'about:blank',
    async goto(url) {
      page.visited.push(url);
      page.current = redirect(url);
    },
    url() {
      return page.current;
    },
    evaluate,
    async waitForTimeout() {},
  };
  return page;
}

module.exports = { fakePage };
