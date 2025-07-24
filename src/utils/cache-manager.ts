export class CacheManager {
    private cache: Cache
    private ctx: ExecutionContext

    constructor(ctx: ExecutionContext) {
        this.cache = caches.default
        this.ctx = ctx
    }

    private generateCacheKey(key: string): Request {
        // Create a unique cache key
        const hash = btoa(key).replace(/[^a-zA-Z0-9]/g, '');
        return new Request(`https://cache.movieworker.dev/v1/${hash}_v3`, {
            method: 'GET'
        })
    }

    async get(key: string): Promise<Response | null> {
        const cacheKey = this.generateCacheKey(key)
        const response = await this.cache.match(cacheKey)

        if (response) {
            return response
        }

        return null
    }

    async set(key: string, response: Response, maxAge: number = 3600): Promise<void> {
        const cacheKey = this.generateCacheKey(key)

        // Preserve original headers and add cache metadata
        const originalHeaders = Object.fromEntries(response.headers.entries())
        const cacheResponse = new Response(response.body, {
            status: response.status,
            headers: {
                ...originalHeaders,
                'Cache-Control': `public, max-age=${maxAge}`,
                'X-Cached-At': new Date().toISOString(),
                'X-Cache-Age': '0'
            },
        })

        this.ctx.waitUntil(this.cache.put(cacheKey, cacheResponse))
    }
}
