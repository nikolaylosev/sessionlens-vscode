// @ts-check
/* SessionLens panel — entry point. `npm run build` (esbuild) bundles src/webview into media/app.js, an IIFE loaded
   by sidepanel.html after the other media/*.js scripts. Each module's statements run in init<Name>(), called here in
   the order the single app.js (before phase 7) ran them; functions are plain exports. */
import { initCommon } from "./common.js";
import { initStore } from "./store.js";
import { initAnalysis } from "./analysis.js";
import { initSessions } from "./sessions.js";
import { initReview } from "./review.js";
import { initCalibration } from "./calibration.js";
import { initRules } from "./rules.js";
import { initPrompts } from "./prompts.js";
import { initSettings } from "./settings.js";
import { initMain } from "./main.js";

initCommon();
initStore();
initAnalysis();
initSessions();
initReview();
initCalibration();
initRules();
initPrompts();
initSettings();
initMain();
