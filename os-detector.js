/**
 * OS Detection and Platform-Specific Download Handler
 * Detects user OS and provides platform-specific download links
 */

class OSDetector {
    constructor() {
        this.os = this.detectOS();
        this.osName = this.getOSName();
        this.downloadLinks = {
            macos: 'https://azha-moh.vercel.app/downloads/AZHA-MOH-mac.dmg',
            chromeos: 'https://azha-moh.vercel.app/downloads/AZHA-MOH-chrome.crx',
            windows: 'https://azha-moh.vercel.app/downloads/AZHA-MOH-win.exe',
            linux: 'https://azha-moh.vercel.app/downloads/AZHA-MOH-linux.AppImage'
        };
    }

    /**
     * Detects the operating system from user agent
     * @returns {string} OS identifier (macos, windows, linux, chromeos, android, ios)
     */
    detectOS() {
        const userAgent = navigator.userAgent.toLowerCase();
        
        // Chrome OS detection
        if (/cros/i.test(userAgent)) {
            return 'chromeos';
        }
        
        // macOS detection
        if (/macintosh|mac os x/i.test(userAgent)) {
            return 'macos';
        }
        
        // Windows detection
        if (/win32|win64|windows|wince/i.test(userAgent)) {
            return 'windows';
        }
        
        // Linux detection
        if (/linux/i.test(userAgent) && !/android/i.test(userAgent)) {
            return 'linux';
        }
        
        // Android detection
        if (/android/i.test(userAgent)) {
            return 'android';
        }
        
        // iOS detection
        if (/iphone|ipad|ipod/i.test(userAgent)) {
            return 'ios';
        }
        
        return 'unknown';
    }

    /**
     * Get human-readable OS name
     * @returns {string} Human-readable OS name
     */
    getOSName() {
        const names = {
            macos: 'macOS',
            windows: 'Windows',
            linux: 'Linux',
            chromeos: 'ChromeOS',
            android: 'Android',
            ios: 'iOS',
            unknown: 'Your OS'
        };
        return names[this.os] || 'Your System';
    }

    /**
     * Check if current OS supports native download
     * @returns {boolean} True if OS is macOS or ChromeOS
     */
    isSupportedOS() {
        return this.os === 'macos' || this.os === 'chromeos';
    }

    /**
     * Get the download link for current OS
     * @returns {string|null} Download URL or null if not available
     */
    getDownloadLink() {
        return this.downloadLinks[this.os] || null;
    }

    /**
     * Get installation instructions
     * @returns {string} HTML installation instructions
     */
    getInstallationInstructions() {
        const instructions = {
            macos: `
                <h3>Installing AZHA MOH on macOS</h3>
                <ol>
                    <li>Download the .dmg file</li>
                    <li>Open the .dmg file from Downloads</li>
                    <li>Drag AZHA MOH to Applications folder</li>
                    <li>Open Applications and double-click AZHA MOH</li>
                    <li>Grant necessary permissions when prompted</li>
                </ol>
            `,
            chromeos: `
                <h3>Installing AZHA MOH on ChromeOS</h3>
                <ol>
                    <li>Download the .crx file</li>
                    <li>Open Chrome and go to chrome://extensions/</li>
                    <li>Enable "Developer mode" (top right toggle)</li>
                    <li>Drag the .crx file into the extensions page</li>
                    <li>Click "Add extension" to confirm</li>
                    <li>AZHA MOH is now installed!</li>
                </ol>
            `,
            windows: `
                <h3>AZHA MOH on Windows</h3>
                <p>Native Windows app coming soon! For now, use the web version or desktop app.</p>
            `,
            linux: `
                <h3>Installing AZHA MOH on Linux</h3>
                <ol>
                    <li>Download the AppImage file</li>
                    <li>Make it executable: chmod +x AZHA-MOH-linux.AppImage</li>
                    <li>Double-click to run or ./AZHA-MOH-linux.AppImage</li>
                    <li>Optional: Create a desktop shortcut for easier access</li>
                </ol>
            `,
            unknown: `
                <h3>Download AZHA MOH</h3>
                <p>We detected you're on an unsupported OS. Please visit our downloads page to find the right version for your system.</p>
            `
        };
        return instructions[this.os] || instructions.unknown;
    }
}

// Global instance
window.osDetector = new OSDetector();

/**
 * Initialize OS detection UI
 */
function initializeOSDetection() {
    const installButton = document.getElementById('installButton');
    const osDetector = window.osDetector;

    if (installButton && osDetector.isSupportedOS()) {
        // Update button text with OS name
        installButton.textContent = `Install AZHA MOH for ${osDetector.osName}`;
        installButton.hidden = false;

        // Add click handler for download
        installButton.addEventListener('click', () => {
            downloadAppForOS(osDetector);
        });
    }
}

/**
 * Handle download for current OS
 * @param {OSDetector} osDetector 
 */
function downloadAppForOS(osDetector) {
    const downloadLink = osDetector.getDownloadLink();
    
    if (downloadLink) {
        // Show installation instructions modal
        showInstallationModal(osDetector);
        
        // Trigger download after brief delay
        setTimeout(() => {
            const link = document.createElement('a');
            link.href = downloadLink;
            link.download = true;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }, 500);
    } else {
        alert(`AZHA MOH is not yet available for ${osDetector.osName}. Please visit our Downloads page for alternatives.`);
    }
}

/**
 * Show installation modal with instructions
 * @param {OSDetector} osDetector 
 */
function showInstallationModal(osDetector) {
    // Create modal if it doesn't exist
    let modal = document.getElementById('installationModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'installationModal';
        modal.className = 'installation-modal';
        document.body.appendChild(modal);
        
        // Add styles
        const style = document.createElement('style');
        style.textContent = `
            .installation-modal {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.7);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
                padding: 20px;
            }
            
            .installation-modal.hidden {
                display: none;
            }
            
            .installation-modal-content {
                background: var(--panel-strong, rgba(10, 18, 28, 0.96));
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 24px;
                padding: 32px;
                max-width: 500px;
                max-height: 80vh;
                overflow-y: auto;
                box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
            }
            
            .installation-modal-close {
                float: right;
                font-size: 24px;
                font-weight: bold;
                cursor: pointer;
                color: var(--text, #f4f2ea);
            }
            
            .installation-modal-close:hover {
                color: var(--gold, #f6c453);
            }
            
            .installation-modal-content h3 {
                color: var(--teal, #65d1b7);
                margin-top: 0;
            }
            
            .installation-modal-content ol,
            .installation-modal-content p {
                color: var(--text, #f4f2ea);
                line-height: 1.6;
            }
        `;
        document.head.appendChild(style);
    }

    // Update modal content
    modal.className = 'installation-modal';
    modal.innerHTML = `
        <div class="installation-modal-content">
            <span class="installation-modal-close" onclick="document.getElementById('installationModal').classList.add('hidden')">&times;</span>
            ${osDetector.getInstallationInstructions()}
            <p style="margin-top: 20px; color: var(--muted, #bfd0d8); font-size: 0.9rem;">
                Your download should start automatically. If it doesn't, please download from our Downloads page.
            </p>
        </div>
    `;
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeOSDetection);
} else {
    initializeOSDetection();
}
