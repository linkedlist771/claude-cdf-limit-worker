const CONFIG = {
    apiauth: 'api_key_here',
    shareUrl: 'https://example.com',
    baseUrl: 'https://api.example.com',
    cookieExpireDays: 7,
    routes: {
        login: /^\/login_oauth$/,
        statsig: /^\/api\/bootstrap\/.*\/statsig$/,
        completion: /^\/api\/organizations\/.*\/chat_conversations\/.*\/completion$/,
        directLogin: /^\/login$/,
        directLogout: /^\/logout$/
    }
};

class RequestHandler {
    constructor(request, env) {
        this.request = request;
        this.url = new URL(request.url);
        this.clientIp = request.headers.get('cf-connecting-ip');
        this.storage = env.storage;
    }

    // Handle authentication
    async handleAuth() {
        const username = this.getCookieValue('username');
        if (!username) {
            return new Response(JSON.stringify({
                status: 'error',
                message: 'Not logged in'
            }), {
                status: 401,
                headers: {
                    'Content-Type': 'application/json'
                }
            });
        }
        return true;
    }

    // Handle chat completion requests
    async handleCompletion() {
        const authResult = await this.handleAuth();
        if (authResult !== true) {
            return authResult;
        }

        this.url.hostname = CONFIG.baseUrl;
        const proxyRequest = new Request(this.url, this.request);
        const response = await fetch(proxyRequest);

        if (response.status === 429) {
            return this.handleRateLimitError(response);
        }

        return this.handleStreamingResponse(response);
    }

    // Handle rate limit errors
    async handleRateLimitError(response) {
        const data = await response.json();
        const errorDetails = JSON.parse(data.error.message);
        const {resetsAt, remaining} = errorDetails;

        if (resetsAt) {
            const email = await this.storage.getEmailByIp(this.clientIp);
            if (email) {
                await this.updateQuotaLimits({
                    email,
                    resetsAt,
                    remaining
                });
            }
        }

        return new Response(JSON.stringify(data), {
            status: response.status,
            headers: response.headers
        });
    }

    // Main request handler
    async handle() {
        const {pathname} = this.url;
        
        try {
            // Route requests based on path
            if (CONFIG.routes.directLogin.test(pathname)) {
                return await this.handleDirectAuth();
            }
            if (CONFIG.routes.login.test(pathname)) {
                return await this.handleLogin();
            }
            if (CONFIG.routes.completion.test(pathname)) {
                return await this.handleCompletion();  
            }
            // Default proxy behavior
            return await this.proxyRequest();
        } catch (error) {
            console.error('Request error:', error);
            throw error;
        }
    }
}

// Export handler
export default {
    async fetch(request, env) {
        const handler = new RequestHandler(request, env);
        return await handler.handle();
    }
};
