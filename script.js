document.addEventListener('DOMContentLoaded', () => {
    const inputLinksEl = document.getElementById('inputLinks');
    const configNameEl = document.getElementById('configName');
    const convertBtn = document.getElementById('convertBtn');
    const outputConfigEl = document.getElementById('outputConfig');
    const copyBtn = document.getElementById('copyBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const saveConfigBtn = document.getElementById('saveConfigBtn');
    const savedConfigsListEl = document.getElementById('savedConfigsList');

    let currentGeneratedConfig = null;

    convertBtn.addEventListener('click', handleConversion);
    copyBtn.addEventListener('click', copyConfig);
    downloadBtn.addEventListener('click', downloadConfig);
    saveConfigBtn.addEventListener('click', saveCurrentConfig);

    loadSavedConfigs();

    async function handleConversion() {
        const linksText = inputLinksEl.value.trim();
        if (!linksText) {
            alert('لطفاً حداقل یک لینک پروکسی یا لینک اشتراک وارد کنید.');
            return;
        }

        outputConfigEl.value = 'در حال پردازش...';
        convertBtn.disabled = true;
        copyBtn.disabled = true;
        downloadBtn.disabled = true;
        saveConfigBtn.disabled = true;

        try {
            const lines = linksText.split('\n').map(line => line.trim()).filter(line => line);
            let allOutbounds = [];

            for (const line of lines) {
                if (line.startsWith('http://') || line.startsWith('https://')) {
                    // Subscription link
                    try {
                        const subOutbounds = await processSubscriptionLink(line);
                        allOutbounds.push(...subOutbounds);
                    } catch (error) {
                        console.error(`Error processing subscription ${line}:`, error);
                        alert(`خطا در پردازش لینک اشتراک ${line}: ${error.message}`);
                    }
                } else {
                    // Single proxy link
                    try {
                        const outbound = parseProxyLink(line);
                        if (outbound) {
                            allOutbounds.push(outbound);
                        }
                    } catch (error) {
                        console.error(`Error processing link ${line}:`, error);
                        // alert(`خطا در پردازش لینک ${line}: ${error.message}`); // Potentially too many alerts
                    }
                }
            }

            if (allOutbounds.length > 0) {
                currentGeneratedConfig = generateFullSingBoxConfig(allOutbounds);
                outputConfigEl.value = JSON.stringify(currentGeneratedConfig, null, 2);
                copyBtn.disabled = false;
                downloadBtn.disabled = false;
                saveConfigBtn.disabled = false;
            } else {
                outputConfigEl.value = 'هیچ پروکسی معتبری برای تبدیل یافت نشد.';
                alert('هیچ پروکسی معتبری برای تبدیل یافت نشد. لطفاً ورودی خود را بررسی کنید.');
            }

        } catch (error) {
            console.error('Conversion error:', error);
            outputConfigEl.value = `خطا: ${error.message}`;
            alert(`خطای کلی در تبدیل: ${error.message}`);
        } finally {
            convertBtn.disabled = false;
        }
    }

    async function processSubscriptionLink(url) {
        const outbounds = [];
        try {
            const response = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`); // Using a CORS proxy
            if (!response.ok) {
                throw new Error(`Network response was not ok: ${response.statusText}`);
            }
            const data = await response.json();
            const decodedContent = atob(data.contents);
            const links = decodedContent.split('\n').map(link => link.trim()).filter(link => link);

            for (const link of links) {
                try {
                    const outbound = parseProxyLink(link);
                    if (outbound) {
                        outbounds.push(outbound);
                    }
                } catch (e) {
                    console.warn(`Skipping invalid link in subscription: ${link}`, e);
                }
            }
        } catch (error) {
            console.error(`Failed to fetch or parse subscription from ${url}:`, error);
            throw new Error(`اشتراک ${url} دریافت نشد: ${error.message}`);
        }
        return outbounds;
    }

    function parseProxyLink(link) {
        if (link.startsWith('vless://')) {
            return parseVlessLink(link);
        } else if (link.startsWith('vmess://')) {
            return parseVmessLink(link);
        } else if (link.startsWith('hysteria2://') || link.startsWith('hy2://')) {
            return parseHysteria2Link(link);
        } else {
            console.warn(`Unsupported link format: ${link}`);
            return null;
        }
    }

    function parseVlessLink(link) {
        const url = new URL(link);
        const params = new URLSearchParams(url.search);
        const tag = decodeURIComponent(url.hash.substring(1)) || `vless-${url.hostname}`;

        const outbound = {
            type: "vless",
            tag: tag,
            server: url.hostname,
            server_port: parseInt(url.port) || 443,
            uuid: url.username,
            tls: {
                enabled: params.get('security') === 'tls' || params.get('security') === 'reality',
                server_name: params.get('sni') || params.get('host') || url.hostname,
                utls: {
                    enabled: true,
                    fingerprint: params.get('fp') || "chrome"
                }
            },
            packet_encoding: "xudp", // Common optimization
        };

        if (params.get('security') === 'reality') {
            outbound.tls.reality = {
                enabled: true,
                public_key: params.get('pbk'),
                short_id: params.get('sid') || ""
            };
            // utls fingerprint typically not used with reality, but sing-box might handle it.
            // If issues, set outbound.tls.utls.enabled = false for reality.
        }

        const flow = params.get('flow');
        if (flow) {
            outbound.flow = flow;
        }
        
        const transportType = params.get('type');
        if (transportType) {
            outbound.transport = { type: transportType };
            if (transportType === 'ws') {
                outbound.transport.path = params.get('path') || "/";
                outbound.transport.headers = { Host: params.get('host') || url.hostname };
            } else if (transportType === 'grpc') {
                outbound.transport.service_name = params.get('serviceName') || "";
                // GRPC can be 'multi' or 'gun' mode, default is often fine.
                // outbound.transport.idle_timeout = "15s";
                // outbound.transport.ping_timeout = "15s";
                // outbound.transport.permit_without_stream = false;
            }
        }
        return outbound;
    }

    function parseVmessLink(link) {
        const base64Config = link.substring(8);
        try {
            const configStr = atob(base64Config);
            const vmessConfig = JSON.parse(configStr);
            const tag = vmessConfig.ps || vmessConfig.add || `vmess-${vmessConfig.add}`;

            const outbound = {
                type: "vmess",
                tag: tag,
                server: vmessConfig.add,
                server_port: parseInt(vmessConfig.port),
                uuid: vmessConfig.id,
                alter_id: parseInt(vmessConfig.aid) || 0,
                security: vmessConfig.scy || "auto", // "none", "aes-128-gcm", etc. "auto" is often best.
                packet_encoding: "xudp",
            };

            if (vmessConfig.tls === 'tls' || vmessConfig.tls === 'reality' || vmessConfig.net === 'ws' && vmessConfig.host) {
                 outbound.tls = {
                    enabled: true,
                    server_name: vmessConfig.sni || vmessConfig.host || vmessConfig.add,
                    utls: {
                        enabled: true,
                        fingerprint: vmessConfig.fp || "chrome"
                    }
                };
                if(vmessConfig.tls === 'reality'){
                     outbound.tls.reality = {
                        enabled: true,
                        public_key: vmessConfig.pbk,
                        short_id: vmessConfig.sid || ""
                    };
                }
            }


            if (vmessConfig.net && vmessConfig.net !== 'tcp') {
                outbound.transport = { type: vmessConfig.net };
                if (vmessConfig.net === 'ws') {
                    outbound.transport.path = vmessConfig.path || "/";
                    outbound.transport.headers = { Host: vmessConfig.host || vmessConfig.add };
                } else if (vmessConfig.net === 'grpc') {
                    outbound.transport.service_name = vmessConfig.path || ""; // Often serviceName is in 'path' for vmess grpc
                }
                // Add other transport types if necessary (http, quic, etc.)
            }
            return outbound;
        } catch (e) {
            console.error("Error parsing VMess link:", e, "Input:", link);
            throw new Error(`لینک VMess نامعتبر: ${link.substring(0, 20)}...`);
        }
    }

    function parseHysteria2Link(link) {
        // hysteria2://auth@host:port?sni=sni.com&up=50&down=100&obfs=salamander&obfs-password=pwd#tag
        // hy2://auth@host:port?sni=sni.com&up=50&down=100&obfs=salamander&obfs-password=pwd#tag
        const url = new URL(link.replace(/^hy2:\/\//, 'hysteria2://'));
        const params = new URLSearchParams(url.search);
        const tag = decodeURIComponent(url.hash.substring(1)) || `hysteria2-${url.hostname}`;

        const outbound = {
            type: "hysteria2",
            tag: tag,
            server: url.hostname,
            server_port: parseInt(url.port),
            up_mbps: parseInt(params.get('up')) || 50, // Default values
            down_mbps: parseInt(params.get('down')) || 100, // Default values
            password: url.username || url.password, // Depending on URL parser, auth might be in username
            tls: {
                enabled: true, // Hysteria2 always uses TLS
                server_name: params.get('sni') || url.hostname,
                utls: { // Hysteria 2 itself handles this, but for consistency with sing-box
                    enabled: true,
                    fingerprint: "chrome" 
                },
                // Hysteria2 specific TLS settings (e.g. insecure, alpn)
                // insecure: params.get('insecure') === '1', // if needed
                alpn: ["h3"] // Hysteria2 commonly uses h3
            }
        };
        
        const obfsType = params.get('obfs');
        if (obfsType) {
            outbound.obfs = {
                type: obfsType, // e.g. "salamander"
                password: params.get('obfs-password') || ""
            };
        }
        
        // Hysteria 2 specific settings
        // outbound.recv_window_conn = parseInt(params.get('recv_window_conn')) || 4194304; // Example
        // outbound.recv_window = parseInt(params.get('recv_window')) || 16777216; // Example
        // outbound.fast_open = true;

        return outbound;
    }


    function generateFullSingBoxConfig(outbounds) {
        const uniqueOutbounds = [];
        const seenTags = new Set();
        let tagCounter = 1;

        for (const outbound of outbounds) {
            let newTag = outbound.tag;
            // Ensure unique tags for sing-box
            while (seenTags.has(newTag)) {
                newTag = `${outbound.tag}-${tagCounter++}`;
            }
            outbound.tag = newTag;
            seenTags.add(newTag);
            uniqueOutbounds.push(outbound);
        }
        
        const outboundTags = uniqueOutbounds.map(o => o.tag);
        let finalOutboundTag = "proxy"; // Default if only one proxy

        if (uniqueOutbounds.length > 1) {
            finalOutboundTag = "auto_select";
            uniqueOutbounds.push({
                type: "urltest",
                tag: "auto_select",
                outbounds: outboundTags,
                url: "http://www.gstatic.com/generate_204", // Lightweight check URL
                interval: "5m", // Test every 5 minutes
                tolerance: 100 // ms tolerance for switching
            });
        } else if (uniqueOutbounds.length === 1) {
            finalOutboundTag = uniqueOutbounds[0].tag;
        } else {
             finalOutboundTag = "direct"; // Fallback if no proxies
        }


        uniqueOutbounds.push({ type: "direct", tag: "direct" });
        uniqueOutbounds.push({ type: "block", tag: "block" });


        return {
            log: {
                level: "info",
                timestamp: true
            },
            dns: {
                servers: [
                    { address: "1.1.1.1", tag: "cloudflare" , detour: finalOutboundTag !== 'direct' ? finalOutboundTag : 'direct'}, // Route DNS through proxy if one exists
                    { address: "8.8.8.8", tag: "google" , detour: finalOutboundTag !== 'direct' ? finalOutboundTag : 'direct'},
                    { address: "223.5.5.5", tag: "alidns", detour: "direct" }, // Local DNS for Iranian domains
                    { address: "185.51.200.2", tag: "shecan", detour: "direct" } // Shecan for Iranian domains
                ],
                rules: [
                    { geosite: ["category-ir"], server: "alidns" },
                    { domain_suffix: [".ir"], server: "alidns" },
                    { server: "cloudflare" } // Default DNS
                ],
                strategy: "ipv4_only", // Or "prefer_ipv4"
                // "disable_cache": true, // Can help with some DNS poisoning
                // "independent_cache": true,
            },
            inbounds: [
                {
                    type: "tun",
                    tag: "tun-in",
                    interface_name: "NotePadVPN-TUN",
                    inet4_address: "172.19.0.1/28", // Small subnet for TUN
                    mtu: 1500,
                    auto_route: true,
                    strict_route: true,
                    endpoint_independent_nat: true,
                    stack: "mixed", // or "gvisor" or "system"
                    sniff: true,
                    sniff_override_destination: false // Useful for some game
                },
                {
                    type: "mixed",
                    tag: "mixed-in",
                    listen: "127.0.0.1",
                    listen_port: 2080, // Common SOCKS/HTTP port
                    sniff: true
                }
            ],
            outbounds: uniqueOutbounds,
            route: {
                rules: [
                    { protocol: ["dns"], outbound: "dns-out" }, // Handle DNS queries separately
                    { domain: ["allatori.com"], outbound: "block" }, // Example block rule
                    { domain_suffix: [".ir", "arvancloud.com", "cdn.ir"], outbound: "direct" },
                    { geosite: ["category-ir"], outbound: "direct" },
                    { geoip: ["ir"], outbound: "direct" },
                    // Route specific apps (example, may need to find their domains/IPs)
                    // { process_name: ["chrome.exe", "firefox.exe"], outbound: finalOutboundTag }, 
                    // { package_name: ["com.android.chrome"], outbound: finalOutboundTag },
                ],
                final: finalOutboundTag,
                auto_detect_interface: true
            },
            experimental: {
                cache_file: { // DNS cache
                    enabled: true,
                    // path: "cache.db", // Needs write permission if not in browser extension
                    // cache_id: "notepad_vpn_dns"
                },
                // "clash_api": { // If you want a Clash-like API
                //    "external_controller": "127.0.0.1:9090",
                //    "external_ui": "ui", // folder name for Yacd or other UI
                //    "secret": "" // API secret
                // }
            }
        };
    }

    function copyConfig() {
        if (outputConfigEl.value) {
            navigator.clipboard.writeText(outputConfigEl.value)
                .then(() => alert('کانفیگ با موفقیت کپی شد!'))
                .catch(err => alert('خطا در کپی کردن: ' + err));
        }
    }

    function downloadConfig() {
        if (outputConfigEl.value) {
            const blob = new Blob([outputConfigEl.value], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const name = (configNameEl.value.trim() || 'singbox_config') + '.json';
            a.href = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    }
    
    function saveCurrentConfig() {
        if (!currentGeneratedConfig) {
            alert('هیچ کانفیگی برای ذخیره وجود ندارد.');
            return;
        }
        let name = configNameEl.value.trim();
        if (!name) {
            name = prompt('لطفاً یک نام برای این کانفیگ وارد کنید:', `config_${Date.now()}`);
        }
        if (name) {
            saveConfigToLocalStorage(name, currentGeneratedConfig);
            loadSavedConfigs(); // Refresh the list
            alert(`کانفیگ "${name}" ذخیره شد.`);
        }
    }

    function saveConfigToLocalStorage(name, config) {
        try {
            let savedConfigs = JSON.parse(localStorage.getItem('notepadVPN_SingBoxConfigs') || '{}');
            savedConfigs[name] = config;
            localStorage.setItem('notepadVPN_SingBoxConfigs', JSON.stringify(savedConfigs));
        } catch (e) {
            console.error("Error saving to localStorage:", e);
            alert('خطا در ذخیره کانفیگ.');
        }
    }

    function loadSavedConfigs() {
        savedConfigsListEl.innerHTML = ''; // Clear current list
        try {
            const savedConfigs = JSON.parse(localStorage.getItem('notepadVPN_SingBoxConfigs') || '{}');
            if (Object.keys(savedConfigs).length === 0) {
                savedConfigsListEl.innerHTML = '<p>هیچ کانفیگی ذخیره نشده است.</p>';
                return;
            }

            for (const name in savedConfigs) {
                const item = document.createElement('div');
                item.classList.add('saved-item');
                item.innerHTML = `
                    <span>${name}</span>
                    <div>
                        <button class="load" data-name="${name}">بارگذاری</button>
                        <button class="delete" data-name="${name}">حذف</button>
                    </div>
                `;
                savedConfigsListEl.appendChild(item);
            }

            savedConfigsListEl.querySelectorAll('.load').forEach(button => {
                button.addEventListener('click', (e) => {
                    const name = e.target.dataset.name;
                    currentGeneratedConfig = savedConfigs[name];
                    outputConfigEl.value = JSON.stringify(currentGeneratedConfig, null, 2);
                    configNameEl.value = name;
                    copyBtn.disabled = false;
                    downloadBtn.disabled = false;
                    saveConfigBtn.disabled = false; // Can re-save with changes or new name
                    openTab(null, 'converter', true); // Switch to converter tab
                    alert(`کانفیگ "${name}" بارگذاری شد.`);
                });
            });

            savedConfigsListEl.querySelectorAll('.delete').forEach(button => {
                button.addEventListener('click', (e) => {
                    const name = e.target.dataset.name;
                    if (confirm(`آیا از حذف کانفیگ "${name}" مطمئن هستید؟`)) {
                        delete savedConfigs[name];
                        localStorage.setItem('notepadVPN_SingBoxConfigs', JSON.stringify(savedConfigs));
                        loadSavedConfigs(); // Refresh list
                        alert(`کانفیگ "${name}" حذف شد.`);
                    }
                });
            });

        } catch (e) {
            console.error("Error loading from localStorage:", e);
            savedConfigsListEl.innerHTML = '<p>خطا در بارگذاری کانفیگ‌های ذخیره شده.</p>';
        }
    }
});

// Tab functionality
function openTab(event, tabName, forceOpen = false) {
    let i, tabcontent, tablinks;
    tabcontent = document.getElementsByClassName("tab-content");
    for (i = 0; i < tabcontent.length; i++) {
        tabcontent[i].style.display = "none";
        tabcontent[i].classList.remove("active");
    }
    tablinks = document.getElementsByClassName("tab-button");
    for (i = 0; i < tablinks.length; i++) {
        tablinks[i].classList.remove("active");
    }
    document.getElementById(tabName).style.display = "block";
    document.getElementById(tabName).classList.add("active");
    if (event && !forceOpen) { // only change button style if clicked, not forced
      event.currentTarget.classList.add("active");
    } else if (forceOpen) { // if forced, find the button for the tabName and activate it
        for (i = 0; i < tablinks.length; i++) {
            if (tablinks[i].getAttribute('onclick').includes(`'${tabName}'`)) {
                tablinks[i].classList.add("active");
                break;
            }
        }
    }
}

// Initialize the first tab
document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('.tab-button.active').click();
});
