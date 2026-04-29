// Backs the `notifications.send` mgmt-api endpoint. There isn't a first-class
// alerting endpoint in Supabase's mgmt-api yet — this is a placeholder that
// records every dispatch so Notify scorers can assert what the agent sent.

export interface NotificationCall {
  channel: string;       // 'slack' | 'pagerduty' | 'email' | ...
  severity: string;
  payload: Record<string, unknown>;
  ts: number;
}

export interface NotificationsHandle {
  send: (call: Omit<NotificationCall, "ts">) => void;
  calls: () => NotificationCall[];
}

export function bootNotifications(): NotificationsHandle {
  const calls: NotificationCall[] = [];
  return {
    send: (c) => calls.push({ ...c, ts: Date.now() }),
    calls: () => [...calls],
  };
}
