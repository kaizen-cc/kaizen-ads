"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Combobox } from "@/components/combobox";
import { tintFor } from "@/lib/colors";
import { createRequest } from "./actions";

type Client = { id: string; name: string; slug: string };

const field = "h-11 w-full rounded-brand border border-line bg-surface px-3 text-sm outline-none transition-colors focus:border-brand-text";
const label = "grid gap-1.5 text-sm";

function Segmented<T extends string>({ name, options, value, onChange }: { name: string; options: { value: T; label: string; hint?: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <label
          key={o.value}
          className={`grid cursor-pointer gap-0.5 rounded-brand border px-3 py-2.5 transition-colors ${
            value === o.value ? "border-brand-text/60 bg-brand-soft" : "border-line bg-surface hover:border-faint"
          }`}
        >
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="sr-only" />
          <span className="text-sm font-medium">{o.label}</span>
          {o.hint && <span className="text-[11px] text-faint">{o.hint}</span>}
        </label>
      ))}
    </div>
  );
}

export function RequestForm({
  clients,
  anglesByClient,
  teamByClient,
  initialClient,
}: {
  clients: Client[];
  anglesByClient: Record<string, string[]>;
  teamByClient: Record<string, Record<string, string>>;
  initialClient: string | null;
}) {
  const router = useRouter();
  const [clientId, setClientId] = useState<string | null>(initialClient);
  const [format, setFormat] = useState<"image" | "video" | "carousel">("image");
  const [kind, setKind] = useState<"new" | "iteration">("new");
  const [priority, setPriority] = useState<"normal" | "high" | "urgent">("normal");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const team = clientId ? teamByClient[clientId] ?? {} : {};
  const maker = format === "video" ? team.video_editor : team.graphic_designer;
  const turnaround = format === "video" ? 4 : 2;
  const due = priority === "urgent" ? Math.floor(turnaround / 2) || "same" : turnaround;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        data.set("client", clientId ?? "");
        setError(null);
        start(async () => {
          const res = await createRequest(data);
          if (res.ok) router.push(`/board?t=${res.number}`);
          else setError(res.error);
        });
      }}
      className="grid gap-7"
    >
      <section className="grid gap-5 rounded-[10px] border border-line bg-surface/60 p-6">
        <div className={label}>
          <span className="text-muted">Client</span>
          <Combobox
            label="Client"
            placeholder="Pick a client"
            value={clientId}
            onChange={setClientId}
            options={clients.map((c) => ({ value: c.id, label: c.name, dot: tintFor(c.name) }))}
          />
        </div>
        <label className={label}>
          <span className="text-muted">Title</span>
          <input name="title" required placeholder="e.g. BFCM · Buy More, Save More" className={field} />
        </label>
        <div className={label}>
          <span className="text-muted">Format</span>
          <Segmented
            name="format"
            value={format}
            onChange={setFormat}
            options={[
              { value: "image", label: "Image", hint: "2 business days" },
              { value: "video", label: "Video", hint: "4 business days" },
              { value: "carousel", label: "Carousel", hint: "2 business days" },
            ]}
          />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className={label}>
            <span className="text-muted">Type</span>
            <Segmented
              name="kind"
              value={kind}
              onChange={setKind}
              options={[
                { value: "new", label: "New creative" },
                { value: "iteration", label: "Iteration" },
              ]}
            />
          </div>
          <div className={label}>
            <span className="text-muted">Priority</span>
            <Segmented
              name="priority"
              value={priority}
              onChange={setPriority}
              options={[
                { value: "normal", label: "Normal" },
                { value: "high", label: "High" },
                { value: "urgent", label: "Urgent" },
              ]}
            />
          </div>
        </div>
      </section>

      <section className="grid gap-5 rounded-[10px] border border-line bg-surface/60 p-6">
        <div className="grid gap-5 sm:grid-cols-2">
          <label className={label}>
            <span className="text-muted">Angle or avatar</span>
            <input name="angle" list="angles" placeholder="Fresh, never frozen" className={field} />
            <datalist id="angles">
              {(clientId ? anglesByClient[clientId] ?? [] : []).map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </label>
          <label className={label}>
            <span className="text-muted">Audience</span>
            <input name="audience" placeholder="Parents of kids 5–12, retargeting" className={field} />
          </label>
        </div>
        <label className={label}>
          <span className="text-muted">Brief</span>
          <textarea
            name="brief"
            rows={6}
            placeholder="What it should say and show. Hooks, offer, references, anything the creative needs."
            className="w-full rounded-brand border border-line bg-surface px-3 py-2.5 text-sm leading-relaxed outline-none focus:border-brand-text"
          />
        </label>
        <div className="grid gap-5 sm:grid-cols-[1fr_auto]">
          <div className={label}>
            <span className="text-muted">Sizes</span>
            <div className="flex flex-wrap gap-2">
              {["1x1", "4x5", "9x16"].map((s) => (
                <label key={s} className="cursor-pointer rounded-full border border-line px-4 py-2 text-sm has-[:checked]:border-brand-text/60 has-[:checked]:bg-brand-soft">
                  <input type="checkbox" name="sizes" value={s} defaultChecked={s !== "1x1"} className="sr-only" />
                  {s.replace("x", ":")}
                </label>
              ))}
            </div>
          </div>
          <label className={label}>
            <span className="text-muted">How many</span>
            <input name="quantity" type="number" min={1} max={100} defaultValue={1} className={`${field} w-24`} />
          </label>
        </div>
        <label className={label}>
          <span className="text-muted">References</span>
          <textarea
            name="refs"
            rows={2}
            placeholder="Paste links: Motion, the ad to iterate, examples (one per line)"
            className="w-full rounded-brand border border-line bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand-text"
          />
        </label>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-muted">
          {clientId ? (
            maker ? (
              <>
                Goes to <span className="text-fg">{maker}</span> · due in {due === "same" ? "the same business day" : `${due} business days`}
              </>
            ) : (
              <span className="text-warn">This client has no {format === "video" ? "video editor" : "designer"} assigned yet. It will land unassigned.</span>
            )
          ) : (
            "Pick a client to see who it goes to."
          )}
        </p>
        <div className="flex items-center gap-3">
          {error && <span className="text-sm text-brand-text">{error}</span>}
          <button
            disabled={pending}
            className="h-11 rounded-brand bg-brand px-6 text-sm font-medium text-white shadow-[0_8px_30px_-8px_rgba(178,30,44,0.7)] hover:bg-brand-hover disabled:opacity-60"
          >
            {pending ? "Creating…" : "Create request"}
          </button>
        </div>
      </div>
    </form>
  );
}
