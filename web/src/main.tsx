import { render } from "preact";
import { App } from "./App";
import { installRendererErrorCapture } from "./error-capture";
import "./index.css";

// Install before render so errors during initial paint are captured.
installRendererErrorCapture();

render(<App />, document.getElementById("app")!);
