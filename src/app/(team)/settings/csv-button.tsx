"use client";

/** Download the rows on screen as a CSV, to check against Ads Manager or a sheet. */
export function CsvButton({ csv, name }: { csv: string; name: string }) {
  return (
    <button
      onClick={() => {
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = name.replace(/[^\w.-]+/g, "-");
        a.click();
        URL.revokeObjectURL(url);
      }}
      className="h-9 rounded-full border border-line px-4 text-sm text-muted transition-colors hover:text-fg"
    >
      Download CSV
    </button>
  );
}
