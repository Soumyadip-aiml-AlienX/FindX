"use client";

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Sparkles, CheckCircle2, ChevronRight, Laptop, Smartphone, Building2, Cpu, Monitor, MemoryStick, Battery, Camera, Gamepad2, ShoppingCart, Star, ShieldCheck } from 'lucide-react';
import styles from './page.module.css';

const REQUIREMENTS = {
  mobile: [
    'Camera Quality',
    'Gaming Performance',
    'Battery Life',
    'UI & Software',
    'Display Quality',
    'Fast Charging',
    'Value for Money'
  ],
  laptop: [
    'Coding & Development',
    'Gaming Performance',
    'Portability & Weight',
    'Battery Life',
    'Display & Color Accuracy',
    'Build Quality',
    'Value for Money'
  ]
};

const COMPANIES = {
  mobile: ['Samsung', 'Apple', 'Xiaomi', 'Redmi', 'Realme', 'OnePlus', 'Vivo', 'Oppo', 'iQOO', 'Motorola', 'Google Pixel', 'Nothing', 'Poco', 'Infinix', 'Tecno', 'Lava', 'Honor'],
  laptop: ['HP', 'Dell', 'Lenovo', 'ASUS', 'Acer', 'Apple', 'MSI', 'Samsung', 'LG', 'Huawei', 'Microsoft', 'Gigabyte', 'Razer']
};

const TOP_BRANDS = new Set([
  'Samsung', 'Apple', 'Xiaomi', 'OnePlus', 'Vivo', 'Oppo', 'Realme', 'iQOO', 'Motorola', 'Google Pixel', 'Redmi', 'Nothing',
  'HP', 'Dell', 'Lenovo', 'ASUS', 'Acer', 'MSI'
]);

// Sound profiles moved inside component

type SearchState = 'idle' | 'searching' | 'results';

export default function Home() {
  const [budget, setBudget] = useState('');
  const [category, setCategory] = useState<'laptop' | 'mobile'>('mobile');
  const [preferredCompanies, setPreferredCompanies] = useState<string[]>([]);
  const [selectedReqs, setSelectedReqs] = useState<string[]>([]);
  const [isAllRounder, setIsAllRounder] = useState(false);
  const [searchState, setSearchState] = useState<SearchState>('idle');
  const [loadingStep, setLoadingStep] = useState(0);
  const [results, setResults] = useState<any>(null);
  const [showLimitWarning, setShowLimitWarning] = useState(false);
  const [limitWarningId, setLimitWarningId] = useState<NodeJS.Timeout | null>(null);
  const playSound = (type: 'click' | 'error') => {
    if (typeof window === 'undefined') return;
    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();

      if (type === 'click') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.05);
        
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
        
        osc.start();
        osc.stop(ctx.currentTime + 0.05);
      } else {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, ctx.currentTime);
        
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
        
        osc.start();
        osc.stop(ctx.currentTime + 0.2);
      }
    } catch (e) {
      console.error("Audio play failed", e);
    }
  };

  const handleCategoryChange = (cat: 'laptop' | 'mobile') => {
    playSound('click');
    setCategory(cat);
    setSelectedReqs([]);
    setIsAllRounder(false);
    setPreferredCompanies([]);
  };

  const toggleReq = (req: string) => {
    if (limitWarningId) clearTimeout(limitWarningId);
    
    setIsAllRounder(false);
    if (selectedReqs.includes(req)) {
      playSound('click');
      setSelectedReqs(selectedReqs.filter(r => r !== req));
      setShowLimitWarning(false);
    } else {
      if (selectedReqs.length < 3) {
        playSound('click');
        setSelectedReqs([...selectedReqs, req]);
        setShowLimitWarning(false);
      } else {
        playSound('error');
        setShowLimitWarning(true);
        const id = setTimeout(() => setShowLimitWarning(false), 3000);
        setLimitWarningId(id);
      }
    }
  };

  const handleSearch = async () => {
    if (!budget || (!isAllRounder && selectedReqs.length === 0)) return;
    playSound('click');
    
    setSearchState('searching');
    setLoadingStep(0);

    const loadingInterval = setInterval(() => {
      setLoadingStep(prev => {
        if (prev >= 4) {
          clearInterval(loadingInterval);
          return prev;
        }
        return prev + 1;
      });
    }, 2000);

    try {
      const response = await fetch('/api/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          budget: Number(budget),
          category,
          preferredCompanies: preferredCompanies.length > 0 ? preferredCompanies : ['Any'],
          requirements: isAllRounder ? ['Best All-Rounder Device'] : selectedReqs,
        }),
      });

      const data = await response.json();
      if (data.success) {
        setResults(data.recommendation);
        setSearchState('results');
      } else {
        alert("Something went wrong!");
        setSearchState('idle');
      }
    } catch (error) {
      console.error(error);
      alert("Error finding recommendations");
      setSearchState('idle');
    } finally {
      clearInterval(loadingInterval);
    }
  };

  const loadingStepsText = [
    "Searching YouTube & watching all recent review videos...",
    "Extracting every device mentioned & comparing them...",
    "Searching for dedicated reviews of top 3 candidates...",
    "Picking top 2 finalists from reviews...",
    "Final head-to-head battle to crown the winner..."
  ];

  return (
    <main className={styles.main}>
      {/* Animated Background Orbs */}
      <div className={styles.orbContainer}>
        <motion.div 
          className={`${styles.orb} ${styles.orb1}`}
          animate={{ x: [0, 100, 0], y: [0, -100, 0] }}
          transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
        />
        <motion.div 
          className={`${styles.orb} ${styles.orb2}`}
          animate={{ x: [0, -100, 0], y: [0, 100, 0] }}
          transition={{ duration: 25, repeat: Infinity, ease: "linear" }}
        />
      </div>

      <AnimatePresence mode="wait">
        {searchState === 'idle' && (
          <motion.div 
            key="form"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -30, scale: 0.95 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
            className={styles.container}
          >
            <div className={styles.hero}>
              <motion.div 
                initial={{ opacity: 0, scale: 0.8 }} 
                animate={{ opacity: 1, scale: 1 }} 
                transition={{ duration: 0.8, type: 'spring' }}
                className={styles.badgeWrapper}
              >
                <span className={styles.premiumBadge}><Sparkles size={14} className={styles.sparkleIcon}/> AI-Powered Precision</span>
              </motion.div>
              <h1 className={styles.title}>
                Discover Your Perfect <br />
                <span className={styles.gradientText}>Tech Match</span>
              </h1>
              <p className={styles.subtitle}>
                Define your budget and priorities. Our advanced AI scans hundreds of recent YouTube reviews to find exactly what you need.
              </p>
            </div>

            <div className={`${styles.glassPanel} ${styles.formContainer}`}>
              <div className={styles.formGroup}>
                <label className={styles.label}>1. What are you looking for?</label>
                <div className={styles.toggleGroup}>
                  <button 
                    className={`${styles.toggleBtn} ${category === 'mobile' ? styles.active : ''}`}
                    onClick={() => handleCategoryChange('mobile')}
                  >
                    <Smartphone size={20} className={styles.iconMargin} />
                    Mobile Device
                  </button>
                  <button 
                    className={`${styles.toggleBtn} ${category === 'laptop' ? styles.active : ''}`}
                    onClick={() => handleCategoryChange('laptop')}
                  >
                    <Laptop size={20} className={styles.iconMargin} />
                    Laptop
                  </button>
                </div>
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>2. Preferred Brands (Optional)</label>
                
                <div style={{marginBottom: '1.5rem'}}>
                  <button 
                    className={`${styles.allRounderBtn} ${preferredCompanies.length === 0 ? styles.activeAllRounder : ''}`}
                    onClick={() => { playSound('click'); setPreferredCompanies([]); }}
                  >
                    <Building2 size={18} style={{marginRight: '8px'}} />
                    Search All Brands (No Preference)
                  </button>
                </div>

                <div className={styles.chips} style={{ opacity: preferredCompanies.length === 0 ? 0.5 : 1 }}>
                  {COMPANIES[category].map(company => {
                    const isTop = TOP_BRANDS.has(company);
                    const isActive = preferredCompanies.includes(company);
                    return (
                    <button
                      key={company}
                      className={`${styles.brandChip} ${isTop ? styles.topBrandChip : ''} ${isActive ? styles.activeBrand : ''}`}
                      onClick={() => { 
                        playSound('click'); 
                        if (isActive) {
                          setPreferredCompanies(preferredCompanies.filter(c => c !== company));
                        } else {
                          setPreferredCompanies([...preferredCompanies, company]);
                        }
                      }}
                    >
                      {isTop && <Star size={12} className={styles.topStar} fill="currentColor" />}
                      {company}
                    </button>
                  )})}
                </div>
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>3. Maximum Budget (INR)</label>
                <div className={styles.currencyInput}>
                  <span className={styles.currencySymbol}>₹</span>
                  <input 
                    type="number" 
                    className={styles.input}
                    placeholder="e.g. 50000"
                    value={budget}
                    onChange={(e) => setBudget(e.target.value)}
                  />
                </div>
              </div>

              <div className={styles.formGroup}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                  <label className={styles.label} style={{marginBottom: 0}}>4. Top Priorities (Select up to 3)</label>
                  <AnimatePresence>
                    {showLimitWarning && (
                      <motion.span 
                        initial={{ opacity: 0, x: 10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0 }}
                        className={styles.limitWarning}
                      >
                        Maximum 3 priorities allowed
                      </motion.span>
                    )}
                  </AnimatePresence>
                </div>
                
                <div style={{marginBottom: '1.5rem'}}>
                  <button 
                    className={`${styles.allRounderBtn} ${isAllRounder ? styles.activeAllRounder : ''}`}
                    onClick={() => {
                      playSound('click');
                      setIsAllRounder(!isAllRounder);
                      if (!isAllRounder) setSelectedReqs([]);
                    }}
                  >
                    <Sparkles size={18} style={{marginRight: '8px'}} />
                    Just give me the Best All-Rounder
                  </button>
                </div>

                <div className={styles.chips} style={{ opacity: isAllRounder ? 0.5 : 1 }}>
                  {REQUIREMENTS[category].map(req => (
                    <button
                      key={req}
                      className={`${styles.chip} ${selectedReqs.includes(req) ? styles.active : ''}`}
                      onClick={() => toggleReq(req)}
                    >
                      {req}
                    </button>
                  ))}
                </div>
              </div>

              <button 
                className={`btn-primary ${styles.submitBtn}`}
                onClick={handleSearch}
                disabled={!budget || (!isAllRounder && selectedReqs.length === 0)}
              >
                <span>Find My Perfect Device</span>
                <ChevronRight size={20} />
              </button>
            </div>
          </motion.div>
        )}

        {searchState === 'searching' && (
          <motion.div 
            key="loading"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className={styles.loadingContainer}
          >
            <div className={styles.glowingSpinner}></div>
            <div className={styles.loadingSteps}>
              {loadingStepsText.map((text, idx) => (
                <motion.div 
                  key={idx} 
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: loadingStep >= idx ? 1 : 0.3, x: 0 }}
                  className={`${styles.loadingStep} ${loadingStep === idx ? styles.activeStep : ''} ${loadingStep > idx ? styles.completedStep : ''}`}
                >
                  {loadingStep > idx ? <CheckCircle2 size={24} className={styles.successIcon} /> : <div className={styles.stepDot} />}
                  <span>{text}</span>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}

        {searchState === 'results' && results && (
          <motion.div 
            key="results"
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            className={styles.resultsContainer}
          >
            <div className={styles.hero}>
              <h1 className={styles.title}>Your AI-Verified <span className={styles.gradientText}>Results</span></h1>
              <p className={styles.subtitle}>Based on deep analysis of recent Indian tech reviews.</p>
            </div>

            <div className={styles.comparisonGrid}>
              {results.devices && results.devices.length > 0 ? (
                results.devices.map((device: any, index: number) => (
                  <motion.div 
                    key={index}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: index * 0.15, type: 'spring' }}
                    className={`${styles.deviceCard} ${index === 0 ? styles.winner : ''}`}
                  >
                    {index === 0 && <div className={styles.winnerBadge}>🏆 Top Pick</div>}
                    <div className={styles.cardHeader}>
                      <h2 className={styles.deviceName}>
                        {device.name}
                        {device.release_year && <span className={styles.releaseYear}> ({device.release_year})</span>}
                      </h2>
                      <div className={styles.devicePrice}>~ ₹{device.price}</div>
                    </div>
                    
                    {device.specs && (
                      <div className={styles.specsGrid}>
                        <div className={styles.specItem}>
                          <Cpu size={18} className={styles.specIcon} />
                          <div className={styles.specContent}>
                            <span className={styles.specLabel}>Processor</span>
                            <span className={styles.specValue}>{device.specs.processor}</span>
                          </div>
                        </div>
                        <div className={styles.specItem}>
                          <Monitor size={18} className={styles.specIcon} />
                          <div className={styles.specContent}>
                            <span className={styles.specLabel}>Display</span>
                            <span className={styles.specValue}>{device.specs.display}</span>
                          </div>
                        </div>
                        <div className={styles.specItem}>
                          <MemoryStick size={18} className={styles.specIcon} />
                          <div className={styles.specContent}>
                            <span className={styles.specLabel}>RAM & Storage</span>
                            <span className={styles.specValue}>{device.specs.ram_storage}</span>
                          </div>
                        </div>
                        <div className={styles.specItem}>
                          <Battery size={18} className={styles.specIcon} />
                          <div className={styles.specContent}>
                            <span className={styles.specLabel}>Battery</span>
                            <span className={styles.specValue}>{device.specs.battery}</span>
                          </div>
                        </div>
                        <div className={styles.specItem}>
                          {category === 'mobile' ? <Camera size={18} className={styles.specIcon} /> : <Gamepad2 size={18} className={styles.specIcon} />}
                          <div className={styles.specContent}>
                            <span className={styles.specLabel}>{category === 'mobile' ? 'Cameras' : 'GPU'}</span>
                            <span className={styles.specValue}>{device.specs.camera_or_gpu}</span>
                          </div>
                        </div>
                      </div>
                    )}
                    
                    <ul className={styles.featureList}>
                      {device.pros.map((pro: string, i: number) => (
                        <li key={`pro-${i}`} className={styles.featureItem}>
                          <CheckCircle2 size={20} className={styles.featureIcon} />
                          <span className={styles.featureText}>{pro}</span>
                        </li>
                      ))}
                    </ul>
  
                    <div className={styles.verdict}>
                      <div className={styles.verdictTitle}>Why it fits you:</div>
                      <p>{device.verdict}</p>
                    </div>
  
                    {device.buy_link && (
                      <a href={device.buy_link} target="_blank" rel="noopener noreferrer" className={styles.buyBtn}>
                        <ShoppingCart size={18} />
                        Find Best Price
                      </a>
                    )}
                  </motion.div>
                ))
              ) : (
                <div className={styles.noResults}>
                  <p>No perfect matches found for this specific criteria. Try adjusting your budget or selecting more brands.</p>
                </div>
              )}
            </div>

            <div className={styles.methodologySection}>
              <h3 className={styles.methodologyTitle}>
                <ShieldCheck size={20} className={styles.methodologyIcon} />
                Our Research Methodology
              </h3>
              <div className={styles.methodologyGrid}>
                <div className={styles.methodologyStep}>
                  <div className={styles.stepNum}>01</div>
                  <div className={styles.stepText}>
                    <strong>Watch All Videos:</strong> Searched YouTube and watched 15+ recent review &amp; comparison videos from the last 4 months.
                  </div>
                </div>
                <div className={styles.methodologyStep}>
                  <div className={styles.stepNum}>02</div>
                  <div className={styles.stepText}>
                    <strong>Extract &amp; Compare:</strong> Identified every device mentioned, prioritized the latest ones, and narrowed down to the top 3.
                  </div>
                </div>
                <div className={styles.methodologyStep}>
                  <div className={styles.stepNum}>03</div>
                  <div className={styles.stepText}>
                    <strong>Review Deep-Dive:</strong> Went back to YouTube and watched dedicated reviews for each of the 3 candidates.
                  </div>
                </div>
                <div className={styles.methodologyStep}>
                  <div className={styles.stepNum}>04</div>
                  <div className={styles.stepText}>
                    <strong>Pick Finalists:</strong> Selected the top 2 devices based on real reviewer feedback and user priorities.
                  </div>
                </div>
                <div className={styles.methodologyStep}>
                  <div className={styles.stepNum}>05</div>
                  <div className={styles.stepText}>
                    <strong>Final Battle:</strong> Head-to-head comparison of the 2 finalists to crown the ultimate winner.
                  </div>
                </div>
              </div>
            </div>

            <button 
              className={`btn-secondary ${styles.newSearchBtn}`}
              onClick={() => { playSound('click'); setResults(null); setSearchState('idle'); }}
            >
              Start New Search
            </button>
          </motion.div>
        )}
      </AnimatePresence>

    </main>
  );
}
