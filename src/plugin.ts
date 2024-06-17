import { ClientUser } from 'discord.js';
import { Plugin, Manager, Player, Track, TrackEndEvent, Structure } from 'magmastream';
import axios from 'axios';

const checkOptions = (options: AutoplayOptions) => {
	if (typeof options.SpotifyTracks !== 'boolean') {
		throw new TypeError('Invalid option: SpotifyTracks must be a boolean');
	}

	if (options.SpotifyTracks) {
		if (!options.spotifyID || !options.spotifySECRET) {
			throw new TypeError('SpotifyTracks is enabled but spotifyID or spotifySECRET is missing');
		}
	}
};

export default class AutoplayPlugin extends Plugin {
	private manager: Manager;
	private options: AutoplayOptions;
	private autoplayEnabled: boolean = false;
	private accessToken: { token: string | null; expire: number; type: string | null } = {
		token: null,
		expire: 0,
		type: null,
	};

	constructor(options: AutoplayOptions) {
		super();
		this.options = { ...options };
	}

	load(manager: Manager) {
		checkOptions(this.options);
		this.manager = manager;
		this.manager.on('queueEnd', this.onQueueEnd.bind(this));

		Structure.extend(
			'Player',
			(Player) =>
				class extends Player {
					public autoplayEnabled: boolean = false;

					/** Sets the autoplay-state of the player. */
					public setAutoplay(autoplayState: boolean, botUser: ClientUser) {
						if (typeof autoplayState !== 'boolean') {
							throw new TypeError('autoplayState must be a boolean.');
						}

						if (!(botUser instanceof ClientUser)) {
							throw new TypeError('botUser must be a ClientUser object.');
						}

						this.autoplayEnabled = autoplayState;
						return this;
					}
				}
		);
	}

	private async handleAutoplay(player: Player, track: Track) {
		const previousTrack = player.queue.previous;

		if (!this.autoplayEnabled || !previousTrack) return;

		const hasSpotifyURL = ['spotify.com', 'open.spotify.com'].some((url) => previousTrack.uri.includes(url));

		if (this.options.SpotifyTracks && hasSpotifyURL) {
			const spotifyTrackID = this.getTrackIdFromUri(previousTrack.uri);
			const recommendations = await this.fetchSpotifyRecommendations(spotifyTrackID);

			if (recommendations && recommendations.length > 0) {
				const foundTrack = recommendations.find((recTrack: SpotifyTrack) => recTrack.uri !== track.uri);

				if (foundTrack) {
					player.queue.add(foundTrack);
					player.play();
				}
			}
			return;
		}

		const hasYouTubeURL = ['youtube.com', 'youtu.be'].some((url) => previousTrack.uri.includes(url));

		let videoID: string;

		if (!hasYouTubeURL) {
			const res = await player.search(`${previousTrack.author} - ${previousTrack.title}`);

			videoID = res.tracks[0].uri.substring(res.tracks[0].uri.indexOf('=') + 1);
		} else {
			videoID = previousTrack.uri.substring(previousTrack.uri.indexOf('=') + 1);
		}

		let randomIndex: number;
		let searchURI: string;

		do {
			randomIndex = Math.floor(Math.random() * 23) + 2;
			searchURI = `https://www.youtube.com/watch?v=${videoID}&list=RD${videoID}&index=${randomIndex}`;
		} while (track.uri.includes(searchURI));

		const res = await player.search(searchURI, player.get('Internal_BotUser'));

		if (res.loadType === 'empty' || res.loadType === 'error') return;

		let tracks = res.tracks;

		if (res.loadType === 'playlist') {
			tracks = res.playlist.tracks;
		}

		const foundTrack = tracks.sort(() => Math.random() - 0.5).find((shuffledTrack) => shuffledTrack.uri !== track.uri);

		if (foundTrack) {
			player.queue.add(foundTrack);
			player.play();
		}
	}

	private getTrackIdFromUri(uri: string): string | null {
		const match = uri.match(/https:\/\/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/);
		return match ? match[1] : null;
	}

	private async fetchSpotifyRecommendations(trackID: string | null) {
		if (!trackID) return [];

		const accessToken = await this.getAccessToken();

		try {
			const response = await axios.get(`https://api.spotify.com/v1/recommendations?seed_tracks=${trackID}`, {
				headers: {
					Authorization: `Bearer ${accessToken.token}`,
				},
			});

			return response.data.tracks.map((track: SpotifyTrack) => ({
				uri: track.external_urls.spotify,
				title: track.name,
				author: track.artists.map((artist: SpotifyArtist) => artist.name).join(', '),
			}));
		} catch (error) {
			console.error('Failed to fetch Spotify recommendations', error);
			return [];
		}
	}

	private getAccessToken() {
		return new Promise<{ token: string; expire: number; type: string }>((resolve, reject) => {
			const { spotifyID, spotifySECRET } = this.options;
			const currentTimestamp = Date.now();

			if (this.accessToken.expire < currentTimestamp - 30000) {
				const url = 'https://accounts.spotify.com/api/token';
				const headers = {
					Authorization: 'Basic ' + Buffer.from(`${spotifyID}:${spotifySECRET}`).toString('base64'),
					'Content-Type': 'application/x-www-form-urlencoded',
				};
				const data = 'grant_type=client_credentials';

				axios
					.post(url, data, { headers })
					.then((response) => {
						const data = response.data;
						this.accessToken.expire = currentTimestamp + data.expires_in * 1000;
						this.accessToken.token = data.access_token;
						this.accessToken.type = data.token_type;
						resolve(this.accessToken);
					})
					.catch((error) => {
						reject('Error while fetching access token: ' + (error.response ? error.response.data : error.message));
					});
			} else {
				resolve(this.accessToken);
			}
		});
	}

	private async onQueueEnd(player: Player, track: Track, payload: TrackEndEvent): Promise<void> {
		player.queue.previous = player.queue.current;
		player.queue.current = null;

		if (!this.autoplayEnabled) {
			player.queue.previous = player.queue.current;
			player.queue.current = null;
			player.playing = false;
			player.manager.emit('queueEnd', player, track, payload);
			return;
		}

		await this.handleAutoplay(player, track);
	}
}

export interface AutoplayOptions {
	SpotifyTracks: boolean;
	spotifyID?: string;
	spotifySECRET?: string;
}

export interface SpotifyTrack {
	uri: string;
	external_urls: {
		spotify: string;
	};
	name: string;
	artists: SpotifyArtist[];
}

export interface SpotifyArtist {
	name: string;
}
