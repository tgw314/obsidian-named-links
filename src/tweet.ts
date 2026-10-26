/**
 * Reads an X (Twitter) post through the FxEmbed API and writes it out as
 * text, so a pasted post lands in a note as its words rather than as a
 * link whose title a reader has to open to see.
 *
 * X itself is no use for this: without running its JavaScript it serves
 * no usable page at all, which is why the title scraper can only reach X
 * through the FxTwitter mirrors. The API at api.fxtwitter.com answers the
 * same post as JSON — text, author, media, quotes and polls — with no key.
 * It is a third-party service, so the plugin only talks to it when the
 * setting for it is on, and only ever sends the post's ID.
 *
 * Like the scraper, this module imports no Obsidian and takes its HTTP
 * client as an argument, so the unit tests run it under plain Node.
 */
import type { HttpClient } from './scraper';

export const DEFAULT_FX_API_BASE = 'https://api.fxtwitter.com';

export interface TweetAuthor {
  name: string;
  screenName: string;
}

export interface TweetPhoto {
  url: string;
  altText: string | null;
}

export interface TweetVideo {
  url: string;
  thumbnailUrl: string | null;
}

export interface TweetPollChoice {
  label: string;
  /** Share of the vote, 0 to 100. */
  percentage: number;
}

export interface Tweet {
  id: string;
  /** The canonical URL of the post, as the API reports it. */
  url: string;
  /** The post's text with its shortened links expanded. */
  text: string;
  author: TweetAuthor;
  /** The day the post was made, as `YYYY-MM-DD` in UTC. */
  date: string | null;
  /** When the post was made, as seconds since the epoch. */
  timestamp: number | null;
  photos: TweetPhoto[];
  videos: TweetVideo[];
  poll: TweetPollChoice[] | null;
  quote: Tweet | null;
}

const TWEET_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
]);

/**
 * The ID of the post a URL points at, or null when the URL isn't one.
 * Every shape X hands out — `/{user}/status/{id}`, the `/i/web/status/`
 * share form, a trailing `/photo/1` — ends at the same ID, and the API
 * needs nothing else, so a renamed account never breaks the lookup.
 */
export function tweetIdOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!TWEET_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const match = /\/status\/(\d+)(?:\/|$)/.exec(parsed.pathname);
  return match ? match[1] : null;
}

export function isTweetUrl(url: string): boolean {
  return tweetIdOf(url) !== null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        .map((entry) => record(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
}

interface Facet {
  type: string;
  start: number;
  end: number;
  replacement: string | null;
}

/**
 * The post's text with what its facets say applied. The API's plain
 * `text` keeps every link shortened to a t.co URL, including the one it
 * appends for the post's own media; `raw_text.facets` gives each span's
 * kind and, for links, the address it really leads to. URL facets are
 * expanded, media facets are dropped (the media is embedded below the
 * text instead), and mentions and hashtags already read as they should.
 *
 * Facet indices are UTF-16 code units, which is what JavaScript strings
 * are indexed by, so they can be used as they arrive.
 */
function expandText(status: Record<string, unknown>): string {
  const raw = record(status.raw_text);
  const plain = str(status.text) ?? '';
  if (!raw) return plain;
  const rawText = str(raw.text);
  if (rawText === null) return plain;

  let text = rawText;
  let offset = 0;
  const range = raw.display_text_range;
  if (
    Array.isArray(range) &&
    typeof range[0] === 'number' &&
    typeof range[1] === 'number'
  ) {
    text = rawText.slice(range[0], range[1]);
    offset = range[0];
  }

  const facets: Facet[] = list(raw.facets)
    .map((facet) => {
      const indices = facet.indices;
      if (
        !Array.isArray(indices) ||
        typeof indices[0] !== 'number' ||
        typeof indices[1] !== 'number'
      ) {
        return null;
      }
      return {
        type: str(facet.type) ?? '',
        start: indices[0] - offset,
        end: indices[1] - offset,
        replacement: str(facet.replacement),
      };
    })
    .filter((facet): facet is Facet => facet !== null)
    .filter((facet) => facet.start >= 0 && facet.end <= text.length)
    // Last first, so an edit never moves the spans still to come.
    .sort((a, b) => b.start - a.start);

  for (const facet of facets) {
    if (facet.type === 'url' && facet.replacement !== null) {
      text =
        text.slice(0, facet.start) + facet.replacement + text.slice(facet.end);
    } else if (facet.type === 'media') {
      text = text.slice(0, facet.start) + text.slice(facet.end);
    }
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function parseTweet(value: unknown, depth: number): Tweet | null {
  const status = record(value);
  if (!status) return null;
  const id = str(status.id);
  const author = record(status.author);
  const name = author ? str(author.name) : null;
  const screenName = author ? str(author.screen_name) : null;
  if (!id || !name || !screenName) return null;

  const media = record(status.media) ?? {};
  const photos = list(media.photos)
    .map((photo) => {
      const url = str(photo.url);
      return url ? { url, altText: str(photo.altText) } : null;
    })
    .filter((photo): photo is TweetPhoto => photo !== null);
  const videos = list(media.videos)
    .map((video) => {
      const url = str(video.url);
      return url ? { url, thumbnailUrl: str(video.thumbnail_url) } : null;
    })
    .filter((video): video is TweetVideo => video !== null);
  const external = record(media.external);
  if (external) {
    const url = str(external.url);
    if (url) {
      videos.push({ url, thumbnailUrl: str(external.thumbnail_url) });
    }
  }

  const pollData = record(status.poll);
  const poll = pollData
    ? list(pollData.choices)
        .map((choice) => {
          const label = str(choice.label);
          const percentage = num(choice.percentage);
          return label !== null && percentage !== null
            ? { label, percentage }
            : null;
        })
        .filter((choice): choice is TweetPollChoice => choice !== null)
    : null;

  const timestamp = num(status.created_timestamp);

  return {
    id,
    url: str(status.url) ?? `https://x.com/${screenName}/status/${id}`,
    text: expandText(status),
    author: { name, screenName },
    date:
      timestamp !== null
        ? new Date(timestamp * 1000).toISOString().slice(0, 10)
        : null,
    timestamp,
    photos,
    videos,
    poll: poll && poll.length > 0 ? poll : null,
    // A quote of a quote of a quote reads worse the deeper it goes, and
    // an unavailable quote arrives as a tombstone with no text or author
    // to parse, which parseTweet already answers with null.
    quote: depth < 2 ? parseTweet(status.quote, depth + 1) : null,
  };
}

export interface FetchTweetOptions {
  http: HttpClient;
  /** The FxEmbed instance to ask; a self-hosted one can stand in. */
  apiBase?: string;
}

/**
 * The post a tweet URL points at, or null when it can't be read: the API
 * is unreachable, the post was deleted or is protected (the API answers
 * 404 or 401 with no post), or the answer wasn't the shape it promises.
 */
export async function fetchTweet(
  url: string,
  options: FetchTweetOptions
): Promise<Tweet | null> {
  const id = tweetIdOf(url);
  if (!id) return null;
  const base = (options.apiBase ?? '').trim().replace(/\/+$/, '');
  const apiBase = base === '' ? DEFAULT_FX_API_BASE : base;

  let res;
  try {
    res = await options.http({
      url: `${apiBase}/2/status/${id}`,
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return null;
  }
  if (res.status !== 200) return null;

  try {
    const data = record(
      JSON.parse(new TextDecoder('utf-8').decode(res.body()))
    );
    if (!data || data.code !== 200) return null;
    return parseTweet(data.status, 0);
  } catch {
    return null;
  }
}

/** The shapes an embedded post can take in a note. */
export type TweetEmbedStyle = 'blockquote' | 'callout';

export interface TweetEmbedLabels {
  /** Alt text naming a video's thumbnail as a video. */
  video: string;
}

export interface FormatTweetOptions {
  /** Embed the post's photos and videos under its text. */
  media: boolean;
  /** The shape to write the post in. */
  style: TweetEmbedStyle;
  labels: TweetEmbedLabels;
  /**
   * The timezone the post's time is written in, as an IANA name. Left
   * out, the reader's own timezone is used, which is what a note wants.
   */
  timeZone?: string;
}

function escapeName(text: string): string {
  return text.replace(/([\\*_`[\]])/g, '\\$1');
}

/**
 * Obsidian reads a `#tag` written in a note as one of the vault's own
 * tags, so a post's hashtags would scatter tags the reader never made.
 * Escape the `#` that opens a tag: at the start of a word, followed by
 * a letter or number. One inside a word (`C#`) or a URL's fragment is
 * not a tag in Obsidian either and is left as the author wrote it.
 */
function escapeHashtags(text: string): string {
  return text.replace(/(^|\s)#(?=[\p{L}\p{N}_/-])/gu, '$1\\#');
}

/** Alt text can't hold the brackets or line breaks that would end it. */
function altTextOf(text: string | null): string {
  return (text ?? '').replace(/[[\]\n\r]/g, ' ').trim();
}

function profileUrlOf(tweet: Tweet): string {
  return `https://x.com/${tweet.author.screenName}`;
}

/**
 * When the post was made, as `YYYY-MM-DD HH:mm` in the chosen timezone,
 * or the plain date when the API gave no time of day.
 */
function whenOf(tweet: Tweet, options: FormatTweetOptions): string | null {
  if (tweet.timestamp !== null) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: options.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(tweet.timestamp * 1000));
    const part = (type: string) =>
      parts.find((entry) => entry.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
  }
  return tweet.date;
}

/**
 * Who wrote the post and when: the name links to the author's profile
 * and the time to the post itself, so an embed needs no separate link
 * back at its foot.
 */
function headerOf(tweet: Tweet, options: FormatTweetOptions): string {
  const who = `**[${escapeName(tweet.author.name)}](${profileUrlOf(tweet)}) (@${tweet.author.screenName})**`;
  const when = whenOf(tweet, options);
  return when ? `${who} · [${when}](${tweet.url})` : who;
}

/** The same heading, unbolded, for a callout's title line. */
function titleOf(tweet: Tweet, options: FormatTweetOptions): string {
  const who = `[${escapeName(tweet.author.name)}](${profileUrlOf(tweet)}) (@${tweet.author.screenName})`;
  const when = whenOf(tweet, options);
  return when ? `${who} · [${when}](${tweet.url})` : who;
}

/** A post's own lines, before any quote it carries is nested into it. */
function ownLines(tweet: Tweet, options: FormatTweetOptions): string[] {
  const lines: string[] = [headerOf(tweet, options), ''];
  if (tweet.text !== '') lines.push(...escapeHashtags(tweet.text).split('\n'));
  if (options.media) {
    for (const photo of tweet.photos) {
      lines.push('', `![${altTextOf(photo.altText)}](${photo.url})`);
    }
    for (const video of tweet.videos) {
      lines.push(
        '',
        video.thumbnailUrl
          ? `[![${options.labels.video}](${video.thumbnailUrl})](${video.url})`
          : `[${options.labels.video}](${video.url})`
      );
    }
  }
  if (tweet.poll) {
    lines.push('');
    for (const choice of tweet.poll) {
      lines.push(
        `- ${escapeHashtags(choice.label)} — ${Math.round(choice.percentage)}%`
      );
    }
  }
  return lines;
}

/** A post's lines with its quoted post nested a blockquote deeper. */
function embedLines(tweet: Tweet, options: FormatTweetOptions): string[] {
  const lines = ownLines(tweet, options);
  if (tweet.quote) {
    lines.push('');
    for (const line of embedLines(tweet.quote, options)) {
      lines.push(line === '' ? '>' : `> ${line}`);
    }
  }
  return lines;
}

/**
 * A post written into a note. As a blockquote it is a heading line —
 * the author, linked, and the time, linking to the post — over the
 * post's text, media and poll, with any quoted post nested a level
 * deeper. As a callout the same heading rides on the callout's title
 * line instead; a quoted post still nests as a plain blockquote inside
 * it, since a callout has no title line of its own to give away.
 */
export function formatTweetEmbed(
  tweet: Tweet,
  options: FormatTweetOptions
): string {
  if (options.style === 'callout') {
    const body = ownLines(tweet, options).slice(2);
    if (tweet.quote) {
      body.push('');
      for (const line of embedLines(tweet.quote, options)) {
        body.push(line === '' ? '>' : `> ${line}`);
      }
    }
    const lines = [`[!quote] ${titleOf(tweet, options)}`, ...body];
    return lines.map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
  }
  const lines = embedLines(tweet, options);
  return lines.map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
}
