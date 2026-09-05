/// What people said on X, transcribed from the posts themselves rather than
/// embedded: every one of these is a reply, and an embed wants a standalone
/// post.
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
    name: "Aguiar Filho",
    handle: "aguiarfilho_",
    url: "https://x.com/aguiarfilho_/status/2092582930287657447",
    avatar: "/avatars/aguiarfilho_.jpg",
    text: "Congrats on the app, man, it’s really great! Do you have any plans to add Codex?",
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
    name: "jan",
    handle: "miaugladiator1",
    url: "https://x.com/miaugladiator1/status/2092577563784737120",
    avatar: "/avatars/miaugladiator1.jpg",
    verified: true,
    text: "uhhhh, this needs codex support though hehe",
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
    name: "Marcus Hohlbein",
    handle: "marcus_hohlbein",
    url: "https://x.com/marcus_hohlbein/status/2094932609725870220",
    avatar: "/avatars/marcus_hohlbein.jpg",
    verified: true,
    text: "Nice 🥵",
  },
];
