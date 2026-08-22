import { EmbeddedTweet, TweetNotFound } from "react-tweet";
import { getTweet, type Tweet } from "react-tweet/api";
import { TWEETS, tweetId } from "@/lib/tweets";

// The syndication endpoint is unauthenticated and unofficial, so it can rate
// limit or go down without warning. A throw here would take the whole page
// with it — this section sits under the pitch and the download button — so a
// failed fetch degrades to one missing card.
async function load(id: string): Promise<Tweet | undefined> {
  try {
    // Next's data cache, not the page's: the marketing copy stays statically
    // rendered and only the tweet payloads are refetched, hourly.
    return await getTweet(id, { next: { revalidate: 3600 } });
  } catch {
    return undefined;
  }
}

export async function Tweets({ className }: { className?: string }) {
  if (TWEETS.length === 0) return null;

  const tweets = await Promise.all(TWEETS.map((entry) => load(tweetId(entry))));

  return (
    <section className={className}>
      <h2 className="mb-4 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
        From X
      </h2>
      {/* `items-start` because the cards are different heights and a grid
          row otherwise stretches the shorter one to match, which pads its
          bottom with empty card instead of ending where the tweet does. */}
      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
        {tweets.map((tweet, i) =>
          tweet ? (
            <EmbeddedTweet key={tweet.id_str} tweet={tweet} />
          ) : (
            <TweetNotFound key={TWEETS[i]} />
          ),
        )}
      </div>
    </section>
  );
}
