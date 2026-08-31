import { useEffect, useRef } from 'react';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import { usePageActivity } from '../context/PageActivityContext';

export default function useRealtimeRefresh({
  channelName,
  tables,
  onChange,
  enabled = true,
  debounceMs = 180,
}) {
  const isPageActive = usePageActivity();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const tableKey = (tables || []).join('|');

  useEffect(() => {
    if (!enabled || !isPageActive || !isSupabaseConfigured || !supabase || !tableKey) {
      return undefined;
    }

    let refreshTimer = null;
    let refreshRunning = false;
    let refreshQueued = false;
    let disposed = false;

    const runRefresh = async () => {
      if (disposed) return;
      if (refreshRunning) {
        refreshQueued = true;
        return;
      }

      refreshRunning = true;
      try {
        await onChangeRef.current?.();
      } finally {
        refreshRunning = false;
        if (refreshQueued && !disposed) {
          refreshQueued = false;
          scheduleRefresh();
        }
      }
    };

    const scheduleRefresh = () => {
      if (refreshTimer) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void runRefresh();
      }, debounceMs);
    };

    let channel = supabase.channel(channelName);
    tableKey.split('|').filter(Boolean).forEach((table) => {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        scheduleRefresh,
      );
    });
    channel.subscribe();

    return () => {
      disposed = true;
      refreshQueued = false;
      if (refreshTimer) {
        window.clearTimeout(refreshTimer);
      }
      void supabase.removeChannel(channel);
    };
  }, [channelName, debounceMs, enabled, isPageActive, tableKey]);
}
