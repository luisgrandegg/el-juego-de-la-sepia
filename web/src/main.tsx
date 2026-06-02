import { createRoot } from "react-dom/client";
import App from "./App";

// Note: intentionally NOT wrapped in <StrictMode>. Strict mode double-invokes
// effects in dev, which would init/teardown/re-init the webcam stream and
// cause a flicker. Re-enable once you're past the hackathon if you want it.
createRoot(document.getElementById("root")!).render(<App />);
