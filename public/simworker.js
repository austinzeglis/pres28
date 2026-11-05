// Runs the simulator off the page's thread so the page stays responsive.
import { simulate } from "./sim.js?v=17";

self.onmessage = ({ data }) => {
  self.postMessage({ key: data.key, result: simulate(data.params, data.draws, data.seed) });
};
