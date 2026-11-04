let configuredOrigins = [];
const permissionButton = document.getElementById("permissions");
permissionButton.disabled = true;
async function initialize() {
    const { bridgeToken } = await chrome.storage.local.get("bridgeToken");
    if (!bridgeToken) { document.getElementById("status").textContent = "Collector pairing is required."; return; }
    const response = await fetch("http://127.0.0.1:4318/v1/origins", { headers: { Authorization: `Bearer ${bridgeToken}` } });
    configuredOrigins = (await response.json()).origins;
    permissionButton.disabled = false;
}
permissionButton.addEventListener("click", async () => {
    // Request directly from the click gesture, after the source list is cached.
    const approved = await chrome.permissions.request({ origins: configuredOrigins });
    document.getElementById("status").textContent = approved ? "Source permissions granted. Resume affected sources in Centrypto." : "Some source permissions remain unavailable.";
});
void initialize().catch(() => { document.getElementById("status").textContent = "Collector bridge unavailable."; });
