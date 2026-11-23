// Shared by the dashboard and the buyer simulator: sends the access password with every
// API call and shows a sign-in box when the server asks for it (status 401).
(function () {
  const KEY = "b2b:access";
  const read = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
  let key = read();
  let asking = null;

  function ask(wrong) {
    if (asking) return asking;
    asking = new Promise((resolve) => {
      const wrap = document.createElement("div");
      wrap.className = "login-wrap";
      wrap.innerHTML = `<form class="login card" autocomplete="on">
          <h2>Sign in</h2>
          <p class="small muted">Enter the access password for this workspace.</p>
          ${wrong ? '<div class="errbox">That password did not work.</div>' : ""}
          <input type="password" name="pw" autocomplete="current-password" aria-label="Password" required autofocus>
          <button class="primary" type="submit">Continue</button>
        </form>`;
      const done = (value) => {
        key = value;
        try { localStorage.setItem(KEY, value); } catch {}
        wrap.remove();
        window.removeEventListener("storage", onStorage);
        resolve();
      };
      // Signing in from one frame of the demo page signs in the other frame too.
      const onStorage = (e) => { if (e.key === KEY && e.newValue && e.newValue !== key) done(e.newValue); };
      window.addEventListener("storage", onStorage);
      wrap.querySelector("form").onsubmit = (e) => { e.preventDefault(); done(e.target.pw.value); };
      document.body.appendChild(wrap);
      wrap.querySelector("input").focus();
    }).finally(() => { asking = null; });
    return asking;
  }

  window.apiFetch = async function (url, opts = {}) {
    for (let attempt = 0; ; attempt++) {
      const latest = read();
      if (latest) key = latest;
      const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), "x-access-key": key } });
      if (res.status !== 401) return res;
      await ask(attempt > 0 || Boolean(key));
    }
  };
})();
