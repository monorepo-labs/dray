/// What people said on X, transcribed from the posts themselves rather than
/// embedded: every one of these is a reply, and an embed wants a standalone
/// post.
///
/// Being replies, they all open with the handles they were addressed to, and
/// **only this account's own is dropped** — reading "@yogesharc" on
/// yogesharc's own page is the page talking to itself. Anyone else in the
/// thread stays, since cutting them rewrites who was being spoken to.
/// Everything else is verbatim, typos included.
///
/// Two posts are quoted short of their end — KKY's, which went on to ask for
/// shortcut customization, a thing the app already has; and Aguiar Filho's,
/// which went on to ask for Codex, which the headline of this very page says
/// it runs. Both cuts are for the same reason: the part removed asks for
/// something that is already here, so leaving it in describes a gap that does
/// not exist.
///
/// **One post is reworded, and it is the only one.** Jongmin Park wrote "the
/// sidebar is weirdly satisfying" and the card says "this is weirdly
/// satisfying", so it reads under the split-view clip rather than naming a
/// part of the app that clip is not about.
///
/// Keep that to one, and prefer a cut. The card carries the person's name,
/// their picture and a link to the post, so anything drawn here is checkable
/// — which makes shortening fair and rewriting a thing a reader can catch.
/// Every other quote on this page is verbatim from its first word to wherever
/// it stops.
///
/// `avatar` is a path under `public/avatars/`. Absent is an ordinary state and
/// draws the initial instead, so a quote can go up before its picture does.
export type Testimonial = {
  name: string;
  handle: string;
  /// The post itself, which is what the card links to: the reply is what a
  /// reader would want to check, where the profile is not.
  url: string;
  text: string;
  avatar?: string;
  /// Drawn as X's blue check, so it is only ever set from what the account
  /// actually carries — `cdn.syndication.twimg.com/tweet-result?id=<id>` answers
  /// it as `user.is_blue_verified`. Defaulting it to true put a badge on two
  /// accounts that have none, which is a claim about somebody else's account.
  verified?: boolean;
};

export const TESTIMONIALS: Testimonial[] = [
  {
    name: "Sourabh",
    handle: "Sousinr",
    url: "https://x.com/Sousinr/status/2090658610401710260",
    avatar: "/avatars/sousinr.jpg",
    verified: true,
    text: "that switching speed is butter",
  },
  {
    name: "Terry Carson",
    handle: "mrterrycarson",
    url: "https://x.com/mrterrycarson/status/2094523965515428018",
    avatar: "/avatars/mrterrycarson.jpg",
    verified: true,
    text: "That's awesome! Looks like a huge upgrade to the workflow. Love seeing these improvements.",
  },
  {
    name: "Felix",
    handle: "vcfgdev",
    url: "https://x.com/vcfgdev/status/2095046763929555405",
    avatar: "/avatars/vcfgdev.jpg",
    verified: true,
    text: "the startup is blazing fast.",
  },
  {
    name: "Aguiar Filho",
    handle: "aguiarfilho_",
    url: "https://x.com/aguiarfilho_/status/2092582930287657447",
    avatar: "/avatars/aguiarfilho_.jpg",
    text: "Congrats on the app, man, it’s really great!",
  },
  {
    name: "Felipe Orlando",
    handle: "felipe__orlando",
    url: "https://x.com/felipe__orlando/status/2092750144680702236",
    avatar: "/avatars/felipe__orlando.jpg",
    verified: true,
    text: "YEEEEEAAAAHHHHHHH",
  },
  {
    name: "Jongmin Park",
    handle: "paakjong",
    url: "https://x.com/paakjong/status/2098289537768390971",
    avatar: "/avatars/paakjong.jpg",
    verified: true,
    text: "this is weirdly satisfying",
  },
  {
    name: "KKY",
    handle: "evilpsycho42",
    url: "https://x.com/evilpsycho42/status/2098313001644507519",
    avatar: "/avatars/evilpsycho42.jpg",
    text: "polished ui and stared.",
  },
  {
    name: "sree.world",
    handle: "sreedotworld",
    url: "https://x.com/sreedotworld/status/2098140473458122755",
    avatar: "/avatars/sreedotworld.jpg",
    verified: true,
    text: "@jullerino feel like this should be a feature on t3code too no?",
  },
];
