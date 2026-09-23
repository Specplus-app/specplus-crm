export function LoadingScreen() {
  return (
    <div className="dark-surface min-h-screen flex items-center justify-center bg-obsidian-950 bg-radial-spotlight">
      <div className="flex flex-col items-center gap-4">
        <div className="w-10 h-10 border-[3px] border-white/15 border-t-brand-500 rounded-full animate-spin" />
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    </div>
  )
}
