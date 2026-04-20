import VIPTray from "@/components/VIPTray";
import InterestGraphFeed from "@/components/InterestGraphFeed";
import BroadcastDashboard from "@/components/BroadcastDashboard";
import BroadcastComposer from "@/components/BroadcastComposer";
import AddictionEngineDeck from "@/components/addiction/AddictionEngineDeck";
import ZeroLoadFeed from "@/components/ZeroLoadFeed";
import EngagementMilestones from "@/src/components/EngagementMilestones";

export default function Home() {
  return (
    <main className="min-h-screen bg-brand-bg transition-opacity duration-500 delay-150">
      <VIPTray />
      <div className="pt-[88px]">
        <BroadcastDashboard />
        <EngagementMilestones currentInteractions={87} dailyGoal={120} />
        <AddictionEngineDeck />
        <ZeroLoadFeed userId="anonymous" />
        <InterestGraphFeed />
      </div>
      <BroadcastComposer />
    </main>
  );
}
