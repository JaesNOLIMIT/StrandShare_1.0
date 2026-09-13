import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Camera,
  Image as ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Replace,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { isSupabaseConfigured, supabase } from "../../../lib/supabaseClient";

const BUCKET = "hair-analysis-reference-images";
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PHOTO_TYPES = [
  {
    id: "healthy",
    label: "Healthy",
    group: "Hair health",
    category: "visible_condition",
    value: "Healthy",
  },
  {
    id: "unhealthy",
    label: "Unhealthy",
    group: "Hair health",
    category: "visible_condition",
    value: "Unhealthy",
  },
  {
    id: "straight",
    label: "Straight",
    group: "Hair Pattern",
    category: "texture",
    value: "Straight",
  },
  {
    id: "wavy",
    label: "Wavy",
    group: "Hair Pattern",
    category: "texture",
    value: "Wavy",
  },
  {
    id: "curly",
    label: "Curly",
    group: "Hair Pattern",
    category: "texture",
    value: "Curly",
  },
  {
    id: "coily",
    label: "Coily",
    group: "Hair Pattern",
    category: "texture",
    value: "Coily",
  },
  {
    id: "thin",
    label: "Thin",
    group: "Density",
    category: "density",
    value: "Thin",
  },
  {
    id: "medium",
    label: "Medium",
    group: "Density",
    category: "density",
    value: "Medium",
  },
  {
    id: "thick",
    label: "Thick",
    group: "Density",
    category: "density",
    value: "Thick",
  },
  {
    id: "oily",
    label: "Oily",
    group: "Visible signs",
    category: "visible_oiliness",
    value: "Oily",
  },
  {
    id: "flaky",
    label: "Flaky",
    group: "Visible signs",
    category: "visible_flaking",
    value: "Flaky",
  },
];

function safeSegment(value) {
  return (
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "reference"
  );
}

function validateImage(file) {
  if (!file) return "Choose a photo first.";
  if (!ACCEPTED_TYPES.has(file.type)) return "Use a JPG, PNG, or WebP image.";
  if (file.size > MAX_FILE_SIZE) return "The image must be 5 MB or smaller.";
  return "";
}

export default function HairReferenceImagesPage() {
  const [items, setItems] = useState([]);
  const [urls, setUrls] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [photoTypeId, setPhotoTypeId] = useState(PHOTO_TYPES[0].id);
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [notice, setNotice] = useState(null);

  const showNotice = (type, message) => {
    setNotice({ type, message });
    window.setTimeout(() => setNotice(null), 3500);
  };

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setLoading(false);
      showNotice("error", "Supabase is not configured.");
      return;
    }

    setLoading(true);
    const { data, error } = await supabase
      .from("hair_analysis_reference_images")
      .select("*")
      .order("reference_category")
      .order("reference_value")
      .order("sort_order")
      .order("reference_image_id");

    if (error) {
      showNotice("error", error.message || "Unable to load reference photos.");
      setLoading(false);
      return;
    }

    const rows = Array.isArray(data) ? data : [];
    setItems(rows);
    const signedEntries = await Promise.all(
      rows.map(async (row) => {
        const result = await supabase.storage
          .from(row.storage_bucket || BUCKET)
          .createSignedUrl(row.storage_path, 60 * 60);
        return [row.reference_image_id, result.data?.signedUrl || ""];
      }),
    );
    setUrls(Object.fromEntries(signedEntries));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!file) {
      setPreviewUrl("");
      return undefined;
    }

    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const selectedPhotoType =
    PHOTO_TYPES.find((type) => type.id === photoTypeId) || PHOTO_TYPES[0];
  const groupedItems = useMemo(
    () =>
      Object.fromEntries(
        PHOTO_TYPES.map((type) => [
          type.id,
          items.filter(
            (item) =>
              item.reference_category === type.category &&
              item.reference_value === type.value,
          ),
        ]),
      ),
    [items],
  );

  const openUpload = (nextTypeId = PHOTO_TYPES[0].id) => {
    setPhotoTypeId(nextTypeId);
    setFile(null);
    setUploadOpen(true);
  };

  const upload = async () => {
    const validation = validateImage(file);
    if (validation) {
      showNotice("error", validation);
      return;
    }

    setBusy("upload");
    let uploadedPath = "";
    try {
      const { data: authData, error: authError } =
        await supabase.auth.getUser();
      if (authError || !authData.user?.id)
        throw authError || new Error("Sign in again before uploading.");
      const extension = file.name.split(".").pop()?.toLowerCase() || "jpg";
      uploadedPath = `${authData.user.id}/${safeSegment(selectedPhotoType.category)}/${safeSegment(selectedPhotoType.value)}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
      const storageResult = await supabase.storage
        .from(BUCKET)
        .upload(uploadedPath, file, {
          cacheControl: "3600",
          contentType: file.type,
          upsert: false,
        });
      if (storageResult.error) throw storageResult.error;

      const existingCount = items.filter(
        (item) =>
          item.reference_category === selectedPhotoType.category &&
          item.reference_value === selectedPhotoType.value,
      ).length;
      const insertResult = await supabase
        .from("hair_analysis_reference_images")
        .insert({
          reference_category: selectedPhotoType.category,
          reference_value: selectedPhotoType.value,
          title: `${selectedPhotoType.label} reference ${existingCount + 1}`,
          storage_bucket: BUCKET,
          storage_path: uploadedPath,
          use_for_ai: true,
          use_for_donor_ui: true,
          is_active: true,
          sort_order: existingCount,
        });
      if (insertResult.error) throw insertResult.error;

      setUploadOpen(false);
      showNotice(
        "success",
        `${selectedPhotoType.label} reference photo uploaded.`,
      );
      await load();
    } catch (error) {
      if (uploadedPath)
        await supabase.storage.from(BUCKET).remove([uploadedPath]);
      showNotice(
        "error",
        error.message || "Unable to upload the reference photo.",
      );
    } finally {
      setBusy("");
    }
  };

  const replace = async (item, replacement) => {
    const validation = validateImage(replacement);
    if (validation) {
      showNotice("error", validation);
      return;
    }

    setBusy(`replace-${item.reference_image_id}`);
    let newPath = "";
    try {
      const { data: authData, error: authError } =
        await supabase.auth.getUser();
      if (authError || !authData.user?.id)
        throw authError || new Error("Sign in again before replacing a photo.");
      const extension =
        replacement.name.split(".").pop()?.toLowerCase() || "jpg";
      newPath = `${authData.user.id}/${safeSegment(item.reference_category)}/${safeSegment(item.reference_value)}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
      const storageResult = await supabase.storage
        .from(BUCKET)
        .upload(newPath, replacement, {
          cacheControl: "3600",
          contentType: replacement.type,
          upsert: false,
        });
      if (storageResult.error) throw storageResult.error;

      const updateResult = await supabase
        .from("hair_analysis_reference_images")
        .update({ storage_bucket: BUCKET, storage_path: newPath })
        .eq("reference_image_id", item.reference_image_id);
      if (updateResult.error) throw updateResult.error;

      await supabase.storage
        .from(item.storage_bucket || BUCKET)
        .remove([item.storage_path]);
      showNotice(
        "success",
        `${item.reference_value} reference photo replaced.`,
      );
      await load();
    } catch (error) {
      if (newPath) await supabase.storage.from(BUCKET).remove([newPath]);
      showNotice("error", error.message || "Unable to replace the photo.");
    } finally {
      setBusy("");
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(`delete-${deleteTarget.reference_image_id}`);
    try {
      const deleteResult = await supabase
        .from("hair_analysis_reference_images")
        .delete()
        .eq("reference_image_id", deleteTarget.reference_image_id);
      if (deleteResult.error) throw deleteResult.error;
      const storageResult = await supabase.storage
        .from(deleteTarget.storage_bucket || BUCKET)
        .remove([deleteTarget.storage_path]);
      if (storageResult.error)
        showNotice(
          "error",
          "The record was deleted, but its old storage file could not be removed.",
        );
      else showNotice("success", "Reference photo deleted.");
      setDeleteTarget(null);
      await load();
    } catch (error) {
      showNotice(
        "error",
        error.message || "Unable to delete the reference photo.",
      );
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900">
            Hair reference photos
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Upload clear examples for each hair characteristic. Multiple photos
            improve the reference library.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />{" "}
            Refresh
          </button>
          <button
            type="button"
            onClick={() => openUpload()}
            className="inline-flex items-center gap-2 rounded-lg bg-[#650817] px-4 py-2 text-sm font-bold text-white"
          >
            <Plus size={16} /> Upload photo
          </button>
        </div>
      </header>

      {loading ? (
        <div className="flex min-h-64 items-center justify-center rounded-2xl border border-slate-200 bg-white text-sm text-slate-500">
          <Loader2 size={18} className="mr-2 animate-spin" /> Loading photos...
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {PHOTO_TYPES.map((type) => {
            const photos = groupedItems[type.id] || [];
            return (
              <section
                key={type.id}
                className="overflow-hidden rounded-2xl border border-slate-200 bg-white"
              >
                <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                  <div>
                    <h3 className="font-bold text-slate-800">{type.label}</h3>
                    <p className="text-xs text-slate-500">
                      {type.group} · {photos.length} photo
                      {photos.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => openUpload(type.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold text-[#650817] hover:bg-[#650817]/5"
                  >
                    <Plus size={14} /> Add
                  </button>
                </header>
                {photos.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => openUpload(type.id)}
                    className="flex w-full flex-col items-center justify-center px-4 py-10 text-slate-400 hover:bg-slate-50"
                  >
                    <ImageIcon size={28} />
                    <span className="mt-2 text-sm font-semibold">
                      Upload the first example
                    </span>
                  </button>
                ) : (
                  <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3">
                    {photos.map((item) => {
                      const isOnlyPhoto = photos.length === 1;
                      return (
                        <article
                          key={item.reference_image_id}
                          className="group overflow-hidden rounded-xl border border-slate-200 bg-slate-50"
                        >
                          <div className="aspect-square bg-slate-100">
                            {urls[item.reference_image_id] ? (
                              <img
                                src={urls[item.reference_image_id]}
                                alt={item.title}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="flex h-full items-center justify-center">
                                <ImageIcon className="text-slate-300" />
                              </div>
                            )}
                          </div>
                          <div className="flex items-center justify-between gap-1 p-2">
                            <p className="min-w-0 truncate text-xs font-semibold text-slate-700">
                              {item.title}
                            </p>
                            <div className="flex shrink-0">
                              <label
                                className="cursor-pointer rounded-md p-1.5 text-slate-500 hover:bg-white hover:text-[#650817]"
                                title="Replace photo"
                              >
                                <Replace size={14} />
                                <input
                                  type="file"
                                  accept="image/jpeg,image/png,image/webp"
                                  className="hidden"
                                  disabled={Boolean(busy)}
                                  onChange={(event) => {
                                    const replacement = event.target.files?.[0];
                                    event.target.value = "";
                                    if (replacement)
                                      void replace(item, replacement);
                                  }}
                                />
                              </label>
                              <button
                                type="button"
                                onClick={() => setDeleteTarget(item)}
                                disabled={isOnlyPhoto || Boolean(busy)}
                                className="rounded-md p-1.5 text-slate-500 hover:bg-white hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-25"
                                title={
                                  isOnlyPhoto
                                    ? "Replace this photo; the last example cannot be deleted."
                                    : "Delete photo"
                                }
                              >
                                {busy ===
                                `delete-${item.reference_image_id}` ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <Trash2 size={14} />
                                )}
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {uploadOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-[2147483000] m-0 flex h-[100dvh] w-screen items-center justify-center overflow-y-auto bg-slate-950/75 p-4 backdrop-blur-[2px]"
            onMouseDown={() => busy !== "upload" && setUploadOpen(false)}
          >
            <section
              role="dialog"
              aria-modal="true"
              aria-labelledby="reference-upload-title"
              onMouseDown={(event) => event.stopPropagation()}
              className="relative w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 opacity-100 shadow-2xl"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3
                    id="reference-upload-title"
                    className="text-xl font-bold text-slate-900"
                  >
                    Upload reference photo
                  </h3>
                  <p className="mt-1 text-sm text-slate-500">
                    Choose the characteristic shown clearly in this image.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setUploadOpen(false)}
                  disabled={busy === "upload"}
                  className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="mt-5">
                <label className="text-sm font-semibold text-slate-700">
                  Photo type
                  <select
                    value={photoTypeId}
                    onChange={(event) => setPhotoTypeId(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5"
                  >
                    {PHOTO_TYPES.map((type) => (
                      <option key={type.id} value={type.id}>
                        {type.label} — {type.group}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="mt-4 block cursor-pointer overflow-hidden rounded-xl border border-dashed border-slate-300 bg-slate-50 text-center hover:border-[#650817]">
                {previewUrl ? (
                  <div className="relative bg-slate-100">
                    <img
                      src={previewUrl}
                      alt={`${selectedPhotoType.label} upload preview`}
                      className="mx-auto h-56 w-full object-contain"
                    />
                    <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-lg bg-slate-950/80 px-3 py-1.5 text-xs font-bold text-white shadow-lg">
                      Change photo
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center px-5 py-9">
                    <UploadCloud size={28} className="text-[#650817]" />
                    <span className="mt-2 text-sm font-bold text-slate-700">
                      Choose a photo
                    </span>
                    <span className="mt-1 text-xs text-slate-500">
                      JPG, PNG, or WebP · maximum 5 MB
                    </span>
                  </div>
                )}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(event) => setFile(event.target.files?.[0] || null)}
                />
              </label>
              {file && (
                <p className="mt-2 truncate text-xs text-slate-500">
                  Selected: {file.name}
                </p>
              )}
              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setUploadOpen(false)}
                  disabled={busy === "upload"}
                  className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-bold text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={upload}
                  disabled={!file || busy === "upload"}
                  className="inline-flex items-center gap-2 rounded-lg bg-[#650817] px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
                >
                  {busy === "upload" ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Camera size={16} />
                  )}
                  {busy === "upload" ? "Uploading..." : "Upload photo"}
                </button>
              </div>
            </section>
          </div>,
          document.body,
        )}

      {deleteTarget &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-[2147483000] m-0 flex h-[100dvh] w-screen items-center justify-center bg-slate-950/75 p-4 backdrop-blur-[2px]"
            onMouseDown={() => !busy && setDeleteTarget(null)}
          >
            <section
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="reference-delete-title"
              onMouseDown={(event) => event.stopPropagation()}
              className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 opacity-100 shadow-2xl"
            >
              <h3
                id="reference-delete-title"
                className="text-lg font-bold text-slate-900"
              >
                Delete this reference photo?
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                This removes the photo permanently. At least one photo for{" "}
                {deleteTarget.reference_value} will remain.
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteTarget(null)}
                  disabled={Boolean(busy)}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={remove}
                  disabled={Boolean(busy)}
                  className="inline-flex items-center gap-2 rounded-lg bg-rose-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                >
                  {busy ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <Trash2 size={15} />
                  )}{" "}
                  Delete photo
                </button>
              </div>
            </section>
          </div>,
          document.body,
        )}

      {notice && (
        <div
          className={`fixed bottom-5 right-5 z-[10100] max-w-sm rounded-xl border px-4 py-3 text-sm font-semibold shadow-xl ${notice.type === "success" ? "border-emerald-200 bg-white text-emerald-700" : "border-rose-200 bg-white text-rose-700"}`}
        >
          {notice.message}
        </div>
      )}
    </div>
  );
}
