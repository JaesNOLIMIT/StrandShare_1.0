import { useCallback, useEffect, useState } from 'react';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

const LEGAL_DOCUMENTS_BUCKET = 'legal-documents';

export default function useActiveLegalDocument(documentType) {
  const [document, setDocument] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setDocument(null);
      setPreviewUrl('');
      setError('Supabase is not configured.');
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError('');
    try {
      const now = new Date().toISOString();
      const result = await supabase
        .from('legal_documents')
        .select('legal_document_id,document_type,version,title,effective_at,file_path')
        .eq('document_type', documentType)
        .eq('is_active', true)
        .lte('effective_at', now)
        .order('effective_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (result.error) throw result.error;
      if (!result.data?.file_path) {
        setDocument(null);
        setPreviewUrl('');
        setError('No active PDF has been published for this form. Ask an administrator to upload it under Manage Requirements → Legal Documents.');
        return;
      }

      const signed = await supabase.storage
        .from(LEGAL_DOCUMENTS_BUCKET)
        .createSignedUrl(result.data.file_path, 60 * 60);
      if (signed.error || !signed.data?.signedUrl) {
        throw signed.error || new Error('Unable to open the active legal PDF.');
      }
      setDocument(result.data);
      setPreviewUrl(signed.data.signedUrl);
    } catch (loadError) {
      setDocument(null);
      setPreviewUrl('');
      setError(loadError?.message || 'Unable to load the active legal PDF.');
    } finally {
      setIsLoading(false);
    }
  }, [documentType]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { document, previewUrl, isLoading, error, reload };
}

