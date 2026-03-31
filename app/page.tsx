import VIPTray from "@/components/VIPTray";
import InterestGraphFeed from "@/components/InterestGraphFeed";

export default function Home() {
  return (
    <main className="min-h-screen bg-brand-bg">
      <VIPTray />
      <div className="pt-[72px]">
        <InterestGraphFeed />
      </div>
    </main>
  );
}
