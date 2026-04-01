/**
 * HiveMindAlgorithm.ts
 *
 * Computes MatchMaker compatibility scores between the local user profile
 * and a pool of candidate profiles.  All computation is client-side — no
 * backend calls are made.
 */

export interface Profile {
  id: string;
  name: string;
  /** Normalised interest vector (values 0-1) */
  interestVector: number[];
  /** Activity score 0-1 */
  activityScore: number;
}

export interface MatchScore {
  profileId: string;
  name: string;
  /** Overall compatibility 0-1 */
  score: number;
  /** Per-dimension affinity values (mirrors interestVector length) */
  heatValues: number[];
}

/** Cosine similarity between two equal-length vectors */
function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

/**
 * Main HiveMind scoring function.
 * Returns a sorted (descending) list of match scores.
 */
export function computeMatchScores(
  viewer: Profile,
  candidates: Profile[]
): MatchScore[] {
  return candidates
    .map((candidate) => {
      const vectorSimilarity = cosineSimilarity(
        viewer.interestVector,
        candidate.interestVector
      );
      const activityBonus = (viewer.activityScore + candidate.activityScore) / 2;
      const score = vectorSimilarity * 0.75 + activityBonus * 0.25;

      // Per-dimension heat: element-wise geometric mean of interest vectors
      const heatValues = viewer.interestVector.map((v, i) =>
        Math.sqrt(v * candidate.interestVector[i])
      );

      return { profileId: candidate.id, name: candidate.name, score, heatValues };
    })
    .sort((a, b) => b.score - a.score);
}

/** Seed data: a pool of demo candidate profiles */
export const DEMO_CANDIDATES: Profile[] = [
  {
    id: "c1",
    name: "Alex",
    interestVector: [0.9, 0.4, 0.7, 0.2, 0.8],
    activityScore: 0.85,
  },
  {
    id: "c2",
    name: "Jordan",
    interestVector: [0.3, 0.9, 0.5, 0.8, 0.1],
    activityScore: 0.72,
  },
  {
    id: "c3",
    name: "Morgan",
    interestVector: [0.6, 0.6, 0.9, 0.3, 0.5],
    activityScore: 0.91,
  },
  {
    id: "c4",
    name: "Riley",
    interestVector: [0.2, 0.7, 0.4, 0.9, 0.6],
    activityScore: 0.65,
  },
  {
    id: "c5",
    name: "Casey",
    interestVector: [0.8, 0.5, 0.6, 0.5, 0.7],
    activityScore: 0.78,
  },
];

/** Viewer profile used on the demo page */
export const VIEWER_PROFILE: Profile = {
  id: "viewer",
  name: "You",
  interestVector: [0.7, 0.5, 0.8, 0.4, 0.6],
  activityScore: 0.8,
};
