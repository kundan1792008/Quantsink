import VIPTray from "@/components/VIPTray";
import InterestGraphFeed from "@/components/InterestGraphFeed";
import BroadcastDashboard from "@/components/BroadcastDashboard";

export default function Home() {
  return (
    <main className="min-h-screen bg-brand-bg transition-opacity duration-500 delay-150">
      <VIPTray />
      <div className="pt-[88px]">
        <BroadcastDashboard />
        <InterestGraphFeed />
      </div>
    </main>
  );
}
