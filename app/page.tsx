"use client"
import { useEffect, useState } from 'react';
import VIPTray from "@/components/VIPTray";
import InterestGraphFeed from "@/components/InterestGraphFeed";

export default function Home() {
  const [livenessPassed, setLivenessPassed] = useState(true);

  // CEO BUGFIX: THE 'NO EXIT' & BIOMETRIC MATRIX LINKS
  useEffect(() => {
    // 1. Biometric Trap (Simulate background check dropping to 0-Bot)
    const bioCheck = setInterval(() => {
      if (Math.random() < 0.05) {
        setLivenessPassed(false);
        setTimeout(() => window.location.href = "quantmail://verify", 3000);
      }
    }, 30000);

    // 2. Ecosystem Matrix Hook (Route to Quantchill unexpectedly)
    const driftCheck = setTimeout(() => {
      if (Math.random() < 0.10) {
        console.warn("Matrix Routing: Shifting to Quantchill Reels");
        window.location.href = "quantchill://reels";
      }
    }, 120000); // Every 2 minutes
    
    return () => { clearInterval(bioCheck); clearTimeout(driftCheck); };
  }, []);

  return (
    <main className={`min-h-screen bg-brand-bg transition-opacity duration-500 delay-150 ${livenessPassed ? 'opacity-100' : 'opacity-0 blur-xl pointer-events-none'}`}>
      <VIPTray />
      <div className="pt-[72px]">
        <InterestGraphFeed />
      </div>
    </main>
  );
}
