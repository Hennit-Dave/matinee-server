import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DETAIL_OVERVIEW_MAX_LENGTH,
  DiscoverQuerySchema,
  GenresResponseSchema,
  MAX_MOVIE_ID,
  MAX_PAGE,
  MAX_QUERY_LENGTH,
  MovieDetailSchema,
  MovieIdParamsSchema,
  MovieSchema,
  MoviesPageSchema,
  NowPlayingQuerySchema,
  PopularQuerySchema,
  SearchQuerySchema,
  normaliseQuery,
} from './movie.js';

test('the Movie contract has exactly id, title, posterUrl, year, overview', () => {
  assert.deepEqual(Object.keys(MovieSchema.shape).sort(), ['id', 'overview', 'posterUrl', 'title', 'year']);
  assert.doesNotThrow(() =>
    MovieSchema.parse({ id: 1, title: 'T', posterUrl: 'https://image.tmdb.org/t/p/w500/a.jpg', year: 2026, overview: 'x' }),
  );
  assert.doesNotThrow(() => MovieSchema.parse({ id: 1, title: 'T', posterUrl: null, year: null, overview: null }));
});

test('the contract rejects extra fields, a non-URL poster and an over-long overview', () => {
  const base = { id: 1, title: 'T', posterUrl: null, year: null, overview: null };
  assert.throws(() => MovieSchema.parse({ ...base, poster_path: '/x.jpg' }));
  assert.throws(() => MovieSchema.parse({ ...base, posterUrl: '/just/a/path.jpg' }));
  assert.throws(() => MovieSchema.parse({ ...base, overview: 'x'.repeat(201) }));
});

test('MoviesPage is a list plus page info', () => {
  assert.deepEqual(Object.keys(MoviesPageSchema.shape).sort(), ['movies', 'page', 'totalPages', 'totalResults']);
});

test('?page defaults to 1, accepts digits 1..MAX_PAGE, and rejects everything else', () => {
  assert.equal(NowPlayingQuerySchema.parse({}).page, 1);
  assert.equal(NowPlayingQuerySchema.parse({ page: '3' }).page, 3);
  assert.equal(NowPlayingQuerySchema.parse({ page: String(MAX_PAGE) }).page, MAX_PAGE);
  for (const bad of ['0', '-1', '1.5', '1e2', '0x10', ' 3', '', 'abc', String(MAX_PAGE + 1), '99999999999999999999']) {
    assert.throws(() => NowPlayingQuerySchema.parse({ page: bad }), `page=${JSON.stringify(bad)} must be rejected`);
  }
  assert.throws(() => NowPlayingQuerySchema.parse({ page: ['1', '2'] }), 'a repeated ?page= is rejected');
});

test('unknown query keys are rejected (strict objects, same as every route)', () => {
  assert.throws(() => NowPlayingQuerySchema.parse({ page: '1', foo: 'bar' }));
  assert.throws(() => SearchQuerySchema.parse({ q: 'dune', foo: 'bar' }));
});

test('search ?q is normalised: trimmed, whitespace collapsed, lower-cased', () => {
  assert.equal(normaliseQuery('  Dune   PART two '), 'dune part two');
  assert.equal(SearchQuerySchema.parse({ q: '  Dune   PART two ' }).q, 'dune part two');
  assert.equal(SearchQuerySchema.parse({ q: 'DUNE' }).q, SearchQuerySchema.parse({ q: ' dune ' }).q);
  assert.equal(SearchQuerySchema.parse({ q: 'dune' }).page, 1);
});

test('search ?q must be present, non-empty after trimming, and at most MAX_QUERY_LENGTH', () => {
  assert.throws(() => SearchQuerySchema.parse({}));
  assert.throws(() => SearchQuerySchema.parse({ q: '' }));
  assert.throws(() => SearchQuerySchema.parse({ q: '   \t ' }));
  assert.throws(() => SearchQuerySchema.parse({ q: ['a', 'b'] }));
  assert.doesNotThrow(() => SearchQuerySchema.parse({ q: 'a'.repeat(MAX_QUERY_LENGTH) }));
  assert.throws(() => SearchQuerySchema.parse({ q: 'a'.repeat(MAX_QUERY_LENGTH + 1) }));
});

test('MovieDetail contract has the expected fields and bounds', () => {
  assert.deepEqual(Object.keys(MovieDetailSchema.shape).sort(), [
    'backdropUrl',
    'cast',
    'certification',
    'director',
    'genres',
    'id',
    'language',
    'overview',
    'posterUrl',
    'rating',
    'releaseDate',
    'runtimeMinutes',
    'tagline',
    'title',
    'year',
  ]);
  assert.doesNotThrow(() =>
    MovieDetailSchema.parse({
      id: 1,
      title: 'T',
      overview: 'x'.repeat(250),
      posterUrl: 'https://image.tmdb.org/t/p/w500/a.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/w780/b.jpg',
      year: 2026,
      releaseDate: '2026-11-07',
      runtimeMinutes: 128,
      genres: ['Drama'],
      rating: 7.8,
      tagline: 'Every frame leaves a trace.',
      certification: '12A',
      language: 'English',
      director: 'Arthur Vance',
      cast: ['First Billed', 'Second Billed'],
    }),
  );
  assert.doesNotThrow(() =>
    MovieDetailSchema.parse({
      id: 1,
      title: 'T',
      overview: null,
      posterUrl: null,
      backdropUrl: null,
      year: null,
      releaseDate: null,
      runtimeMinutes: null,
      genres: [],
      rating: null,
      tagline: null,
      certification: null,
      language: null,
      director: null,
      cast: [],
    }),
  );
  assert.throws(() =>
    MovieDetailSchema.parse({
      id: 1,
      title: 'T',
      overview: 'x'.repeat(DETAIL_OVERVIEW_MAX_LENGTH + 1),
      posterUrl: null,
      backdropUrl: null,
      year: null,
      releaseDate: null,
      runtimeMinutes: null,
      genres: [],
      rating: null,
      tagline: null,
      certification: null,
      language: null,
      director: null,
      cast: [],
    }),
  );
});

test('MovieIdParamsSchema accepts positive integer ids and rejects non-numeric or out-of-range ids', () => {
  assert.equal(MovieIdParamsSchema.parse({ id: '42' }).id, 42);
  assert.equal(MovieIdParamsSchema.parse({ id: String(MAX_MOVIE_ID) }).id, MAX_MOVIE_ID);
  for (const bad of ['0', '-1', 'now-playing', 'search', '1.5', '1e2', '0x10', ' 7', '', String(MAX_MOVIE_ID + 1)]) {
    assert.throws(() => MovieIdParamsSchema.parse({ id: bad }), `id=${JSON.stringify(bad)} must be rejected`);
  }
});

test('GenresResponseSchema validates { genres: [{ id, name }] }', () => {
  assert.deepEqual(GenresResponseSchema.parse({ genres: [{ id: 28, name: 'Action' }] }), {
    genres: [{ id: 28, name: 'Action' }],
  });
  assert.throws(() => GenresResponseSchema.parse({ genres: [{ id: 0, name: 'Action' }] }));
  assert.throws(() => GenresResponseSchema.parse({ genres: [{ id: 28, name: '' }] }));
  assert.throws(() => GenresResponseSchema.parse({ genres: [{ id: 28, name: 'Action', extra: 1 }] }));
});

test('DiscoverQuerySchema validates genreId and defaults/bounds page', () => {
  assert.deepEqual(DiscoverQuerySchema.parse({ genreId: '28' }), { genreId: 28, page: 1 });
  assert.deepEqual(DiscoverQuerySchema.parse({ genreId: '28', page: '5' }), { genreId: 28, page: 5 });
  assert.deepEqual(DiscoverQuerySchema.parse({ genreId: String(MAX_MOVIE_ID), page: String(MAX_PAGE) }), {
    genreId: MAX_MOVIE_ID,
    page: MAX_PAGE,
  });
  for (const bad of [
    {},
    { genreId: '' },
    { genreId: '0' },
    { genreId: '-5' },
    { genreId: 'action' },
    { genreId: '28', page: '0' },
    { genreId: '28', page: String(MAX_PAGE + 1) },
  ]) {
    assert.throws(() => DiscoverQuerySchema.parse(bad), `query=${JSON.stringify(bad)} must be rejected`);
  }
});

test('PopularQuerySchema defaults page to 1 and enforces 1..MAX_PAGE', () => {
  assert.deepEqual(PopularQuerySchema.parse({}), { page: 1 });
  assert.deepEqual(PopularQuerySchema.parse({ page: '3' }), { page: 3 });
  assert.deepEqual(PopularQuerySchema.parse({ page: String(MAX_PAGE) }), { page: MAX_PAGE });
  for (const bad of [{ page: '0' }, { page: String(MAX_PAGE + 1) }, { page: 'abc' }, { extra: '1' }]) {
    assert.throws(() => PopularQuerySchema.parse(bad));
  }
});
