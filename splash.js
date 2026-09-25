(() => {
  const dialog = document.querySelector("#welcome-splash");
  const continueButton = document.querySelector("#welcome-continue");
  const sessionKey = "landmark-journeys-ai-notice-v1";
  if (!dialog || !continueButton) return;

  let dismissedThisSession = false;
  try {
    dismissedThisSession = sessionStorage.getItem(sessionKey) === "seen";
  } catch {
    // Browsers that block session storage still display the notice.
  }

  if (!dismissedThisSession) {
    dialog.showModal();
    continueButton.focus();
  }

  dialog.addEventListener("cancel", (event) => event.preventDefault());
  continueButton.addEventListener("click", () => {
    try {
      sessionStorage.setItem(sessionKey, "seen");
    } catch {
      // Dismissing the current dialog does not require storage access.
    }
    dialog.close();
  });
})();
