export class CacheManager {
    private cache: Cache
    private ctx: ExecutionContext

    constructor(ctx: ExecutionContext) {
        this.cache = caches.default
        this.ctx = ctx
    }

    private generateCacheKey(key: string): Request {
        const hash = btoa(key).replace(/[^a-zA-Z0-9]/g, '');
        return new Request(`https://cache.movieworker.dev/v1/${hash}_v3`, {
            method: 'GET'
        })
    }

    async get(key: string): Promise<Response | null> {
        const cacheKey = this.generateCacheKey(key)
        return await this.cache.match(cacheKey) || null
    }

    async set(key: string, response: Response, maxAge: number = 3600): Promise<void> {
        // Only cache files smaller than 50MB
        const contentLength = parseInt(response.headers.get('content-length') || '0')
        if (contentLength > 50 * 1024 * 1024) {
            return // Skip caching for files > 50MB
        }

        const cacheKey = this.generateCacheKey(key)
        const originalHeaders = Object.fromEntries(response.headers.entries())

        const cacheResponse = new Response(response.body, {
            status: response.status,
            headers: {
                ...originalHeaders,
                'Cache-Control': `public, max-age=${maxAge}`,
                'X-Cached-At': new Date().toISOString()
            },
        })

        this.ctx.waitUntil(this.cache.put(cacheKey, cacheResponse))
    }
}
