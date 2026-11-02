(() => {
  const query = new URLSearchParams(location.search);
  const state = query.get("state");
  const result = query.get("result");
  const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(state || "") && ["return", "cancel"].includes(result);
  history.replaceState(null, "", location.pathname);
  if (valid && window.parent !== window) {
    // This notification is only a prompt to verify the order on the server.
    // No browser return value establishes successful 3DS or requests capture.
    window.parent.postMessage({ type: "editfi:3ds-result", state, result }, location.origin);
    document.getElementById("authentication-return-status").textContent = "Checking authentication with PayPal…";
  } else {
    document.getElementById("authentication-return-status").textContent = "Return to the checkout page to continue this test payment.";
  }
})();
