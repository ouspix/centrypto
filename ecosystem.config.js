module.exports = {
    // Optional WSL/Linux alternative to the Windows logon task. Collection runs
    // under systemd on the VPS; this process connects and runs local inference.
    apps: [{
        name: "centrypto-local-intelligence",
        script: "scripts/start_local_runtime.py",
        interpreter: "python3",
        restart_delay: 5000,
        kill_timeout: 25000,
    }],
};
