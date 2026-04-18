import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-brand-bg flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center">
        <span className="text-[10px] tracking-[0.25em] text-brand-subtext uppercase font-medium">
          Signal Lost
        </span>
        <h1
          className="mt-4 text-5xl font-display font-semibold text-brand-text tracking-tight"
          style={{ fontFamily: "var(--font-display)" }}
        >
          404
        </h1>
        <p className="mt-3 text-[13px] leading-relaxed text-brand-subtext">
          The channel you requested is not on the Pro Broadcast roster.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <div className="h-px flex-1 bg-brand-border" />
          <Link
            href="/"
            className="text-[10px] tracking-[0.22em] font-semibold text-brand-accent uppercase border border-brand-border hover:border-brand-accent transition-colors duration-200 px-4 py-2 rounded-sm"
          >
            Return to Feed
          </Link>
          <div className="h-px flex-1 bg-brand-border" />
        </div>
      </div>
    </main>
  );
}
