import { useEffect, useRef } from 'react';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

export default function useRealtimeRefresh({
  channelName,
  tables,
  onChange,
  enabled = true,
  debounceMs = 180,
}) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const tableKey = (tables || []).join('|');

  useEffect(() => {
    if (!enabled || !isSupabaseConfigured || !supabase || !tableKey) {
      return undefined;
    }

    let refreshTimer = null;
    const scheduleRefresh = () => {
      if (refreshTimer) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        onChangeRef.current?.();
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
      if (refreshTimer) {
        window.clearTimeout(refreshTimer);
      }
      void supabase.removeChannel(channel);
    };
  }, [channelName, debounceMs, enabled, tableKey]);
}
