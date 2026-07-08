import { defineEnvironment } from "@supabase-evals/core";
import base from "./supabase-mcp.js";

/**
 * The baseline environment + the `supabase` skill. The single knob that differs
 * from `supabase-mcp` — this is the "environment" treatment in the h2h.
 */
export default defineEnvironment({ ...base, skills: ["supabase"] });
