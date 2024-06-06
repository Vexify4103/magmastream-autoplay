import { ClientUser } from 'discord.js';
import { Plugin, Manager, Player, Track, TrackEndEvent } from 'magmastream';
import axios from 'axios';

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
	// Add more properties as needed
}

export default class AutoplayPlugin extends Plugin {
	private readonly options: AutoplayOptions;
	private autoplayEnabled: boolean = false;
	private botUser: ClientUser | null = null;
	private spotifyToken: string | null = null;
	private accessToken: { token: string | null; expire: number; type: string | null } = {
		token: null,
		expire: 0,
		type: null,
	};

	constructor(options: AutoplayOptions) {
		super();
		this.options = options;
		this.checkOptions();
	}

	private checkOptions() {
		if (typeof this.options.SpotifyTracks !== 'boolean') {
			throw new Error('Invalid option: SpotifyTracks must be a boolean');
		}
		if (this.options.SpotifyTracks) {
			if (!this.options.spotifyID || !this.options.spotifySECRET) {
				throw new Error('SpotifyTracks is enabled but spotifyID or spotifySECRET is missing');
			}
		}
	}

	load(manager: Manager) {
		console.log('Autoplay plugin loaded with options:', this.options);

		manager.on('queueEnd', (player: Player, track: Track, payload: TrackEndEvent) => {
			this.queueEnd(player, track, payload);
		});
	}

	setAutoplay(autoplayState: boolean, botUser: ClientUser) {
		if (typeof autoplayState !== 'boolean') {
			throw new TypeError('autoplayState must be a boolean.');
		}

		if (!(botUser instanceof ClientUser)) {
			throw new TypeError('botUser must be a ClientUser object.');
		}

		this.autoplayEnabled = autoplayState;
		this.botUser = botUser;

		if (this.options.SpotifyTracks) {
			this.authenticateSpotify();
		}
	}

	private async authenticateSpotify() {
		const { spotifyID, spotifySECRET } = this.options;
		const authString = Buffer.from(`${spotifyID}:${spotifySECRET}`).toString('base64');

		try {
			const response = await axios.post('https://accounts.spotify.com/api/token', 'grant_type=client_credentials', {
				headers: {
					Authorization: `Basic ${authString}`,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
			});

			this.spotifyToken = response.data.access_token;
			console.log('Spotify authenticated successfully');
		} catch (error) {
			console.error('Failed to authenticate with Spotify', error);
		}
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

				console.log('-----');
				console.log(foundTrack);

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

			videoID = res.tracks[0].uri.substring(res.tracks[0].uri.indexOf('=' + 1));
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

			console.log(response.data.tracks);
			return response.data.tracks.map((track: SpotifyTrack) => ({
				uri: track.external_urls.spotify,
				title: track.name,
				author: track.artists.map((artist: SpotifyTrack) => artist.name).join(', '),
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

	protected async queueEnd(player: Player, track: Track, payload: TrackEndEvent): Promise<void> {
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
