import posthog from "posthog-js"

const POSTHOG_PUBLIC_KEY = "phc_q2wUqNSr9AsKvH56PBbg9RX5dGKypQZi1gxk3cuSXJ5"
const POSTHOG_API_HOST = "https://ph.supabase.com"
const POSTHOG_UI_HOST = "https://eu.posthog.com"

export function initAnalytics() {
  posthog.init(POSTHOG_PUBLIC_KEY, {
    api_host: POSTHOG_API_HOST,
    ui_host: POSTHOG_UI_HOST,
    defaults: "2026-01-30",
    persistence: "memory",
    person_profiles: "identified_only",
    autocapture: false,
    capture_pageview: "history_change",
    capture_pageleave: true,
    capture_heatmaps: false,
    capture_dead_clicks: false,
    capture_exceptions: false,
    capture_performance: false,
    disable_session_recording: true,
  })
}
