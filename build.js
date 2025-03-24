// build.js
const exe = require("@angablue/exe");
const fs = require("fs");
const path = require("path");

try {
  // Read the configuration from exe.json
  const configPath = path.join(__dirname, "exe.json"); // Use path.join for cross-platform compatibility
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  // --- Dynamic Version (Optional, but Recommended) ---
  const version = process.env.GITHUB_EVENT_INPUTS_VERSION || "1.0.0"; // Get version from workflow, fallback to 1.0.0
  config.version = version;
  // --- End Dynamic Version ---


  // Build the executable
  const build = exe(config);

  build.then(() => console.log("Build completed!")).catch((err) => {
    console.error("Build failed:", err);
    process.exit(1); // Exit with an error code on failure
  });

} catch (error) {
  console.error("Error reading or parsing exe.json:", error);
  process.exit(1); // Exit with an error code
}
