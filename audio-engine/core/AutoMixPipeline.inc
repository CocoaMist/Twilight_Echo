// Included after DecodeStream's definition. All preparation runs on this
// dedicated worker; its immutable result is retired with the stream epoch.
void AudioPipeline::reclaimAutoMixLocked() {
  const auto acknowledged = renderAckedStreamEpoch_.load(std::memory_order_acquire);
  retiredAutoMix_.erase(std::remove_if(retiredAutoMix_.begin(), retiredAutoMix_.end(),
      [acknowledged](const auto& item) { return item->retiredEpoch <= acknowledged; }), retiredAutoMix_.end());
}

void AudioPipeline::cancelAutoMixLocked(const char* reason) {
  // After manual Next this PCM is the current track's audible continuation,
  // not an old pair proposal. Updating the *following* preload must retain it.
  if(autoMixTransition_&&autoMixTransition_->phase.load(std::memory_order_acquire)==5&&std::string_view(reason)=="queue_changed")return;
  if(autoMixTransition_) {
    unsigned phase=autoMixTransition_->phase.load(std::memory_order_acquire);
    while(phase<2&&!autoMixTransition_->phase.compare_exchange_weak(phase,4,std::memory_order_acq_rel)) {}
    // Promotion owns a short atomic commit. It never takes this mutex; finish
    // observing that commit before withdrawing or replacing either source.
    if(phase==2) {
      while(autoMixTransition_->phase.load(std::memory_order_acquire)==2)std::this_thread::yield();
      synchronizeRenderPromotionLocked();
    }
  }
  ++autoMixSerial_;
  ++autoMixPlanRevision_;
  autoMixJob_.reset();
  autoMixOutgoingFeatures_.clear();autoMixIncomingFeatures_.clear();
  autoMixOutgoingPreparationSource_.clear();autoMixIncomingPreparationSource_.clear();
  renderAutoMix_.store(nullptr, std::memory_order_release);
  if (autoMixTransition_) {
    autoMixTransition_->retiredEpoch = retiredStreamEpoch_.fetch_add(1, std::memory_order_acq_rel) + 1;
    retiredAutoMix_.push_back(std::move(autoMixTransition_));
  }
  autoMixReason_ = reason;
  reclaimAutoMixLocked();
}

void AudioPipeline::setAutoMixConfig(const TAE_AM_ConfigV1& config) {
  std::lock_guard lock(mutex_);
  synchronizeRenderPromotionLocked();
  cancelAutoMixLocked(config.enabled ? "analysis_pending" : "disabled");
  autoMixConfig_ = config;
  renderAutoMixEnabled_.store(config.enabled != 0, std::memory_order_release);
  scheduleAutoMixLocked();
}

bool AudioPipeline::setAutoMixFeatures(const std::string& json,std::string* error) {
  if(json.size()>1024*1024) {if(error)*error="feature_resource_limit";return false;}
  char parseError[256]{};
  struct Free {void operator()(am_json* p)const{am_json_free(p);}};
  std::unique_ptr<am_json,Free> root(am_json_parse(json.c_str(),parseError,sizeof parseError));
  const auto* revision=am_jget(root.get(),"pairRevision");
  if(!root||!revision||revision->type!=AM_JNUMBER||!std::isfinite(revision->number)||revision->number<0||revision->number>0x1fffffffffffff||std::floor(revision->number)!=revision->number) {if(error)*error="invalid_pair_revision";return false;}
  std::lock_guard lock(mutex_);
  synchronizeRenderPromotionLocked();
  const auto* out=am_jget(root.get(),"outgoing");const auto* in=am_jget(root.get(),"incoming");
  if(!autoMixConfig_.enabled||!activeStream_||!preloadStream_||static_cast<uint64_t>(revision->number)!=autoMixSerial_||
      activeStream_->item.source!=am_jstr(am_jget(out,"source"),"")||activeStream_->item.id!=am_jstr(am_jget(out,"id"),"")||
      preloadStream_->item.source!=am_jstr(am_jget(in,"source"),"")||preloadStream_->item.id!=am_jstr(am_jget(in,"id"),"")) {if(error)*error="stale_feature_pair";return false;}
  if(!autoMixOutgoingFeatures_.empty()) {if(error)*error="features_already_delivered";return false;}
  // Fix the pair before the earliest possible intelligent transition. Late
  // results are cached by the host for future playback, never replanned here.
  if((autoMixTransition_&&autoMixTransition_->phase.load(std::memory_order_acquire)!=0)||
      double(renderedFrames_.load(std::memory_order_acquire))/decodeFormat_.sampleRate+autoMixConfig_.max_transition_seconds+2+
      (autoMixConfig_.allow_intelligent_skip?std::min(12.,activeStream_->autoMixDurationSeconds()*.1):0)>=activeStream_->autoMixDurationSeconds()) {if(error)*error="feature_deadline_missed";return false;}
  const auto* a=am_jget(out,"features");const auto* b=am_jget(in,"features");
  if(!a||a->type!=AM_JOBJECT||!b||b->type!=AM_JOBJECT) {if(error)*error="invalid_features";return false;}
  const auto* outSource=am_jget(out,"preparationSource");const auto* inSource=am_jget(in,"preparationSource");
  for(const auto* source:{outSource,inSource})if(source&&(source->type!=AM_JSTRING||!source->string||!source->string[0]||std::strlen(source->string)>8192)) {if(error)*error="invalid_preparation_source";return false;}
  char* aJson=am_json_encode(a);char* bJson=am_json_encode(b);
  if(!aJson||!bJson) {std::free(aJson);std::free(bJson);if(error)*error="feature_resource_limit";return false;}
  std::string aText(aJson),bText(bJson);std::free(aJson);std::free(bJson);
  // Keep a ready conservative buffer while the intelligent replacement is
  // prepared. A failed/late replacement cannot withdraw the pair's fallback.
  ++autoMixPlanRevision_;autoMixScheduledSerial_=UINT64_MAX;autoMixJob_.reset();
  autoMixOutgoingFeatures_=std::move(aText);autoMixIncomingFeatures_=std::move(bText);
  autoMixOutgoingPreparationSource_=am_jstr(outSource,"");autoMixIncomingPreparationSource_=am_jstr(inSource,"");
  scheduleAutoMixLocked();return true;
}

std::string AudioPipeline::autoMixStatusJson() const {
  std::lock_guard lock(mutex_);
  const bool mixing = renderAutoMixStarted_.load(std::memory_order_acquire) && renderAutoMix_.load(std::memory_order_acquire);
  const auto* transition = autoMixTransition_.get();
  const auto frames = renderAutoMixFrames_.load(std::memory_order_acquire);
  const char* state = !autoMixConfig_.enabled ? "disabled" : mixing ? "mixing" : transition ? "ready" : autoMixReason_ == "preparing" ? "preparing" : "degraded";
  std::ostringstream json;
  json << "{\"enabled\":" << (autoMixConfig_.enabled ? "true" : "false") << ",\"state\":\"" << state
       << "\",\"progress\":" << (transition && transition->info.frames ? std::min(1., double(frames)/transition->info.frames) : 0)
       << ",\"transitionSeconds\":" << (transition ? transition->info.transition_seconds : 0) << ",\"styleId\":";
  if (transition) json << transition->info.style_id; else json << "null";
  json << ",\"mixKind\":\"" << (transition?(transition->mixTier==3?"beat_mix":transition->mixTier==2?"musical_overlap":transition->mixTier==1?"boundary_cleanup":"conservative"):"none") << '"'
       << ",\"audibleOverlapSeconds\":" << (transition?transition->mixEvidence.audible_overlap_seconds:0)
       << ",\"tempoAdjustmentPercent\":" << (transition?100*std::max(std::abs(transition->tempoRatio-1),std::abs(1/transition->tempoRatio-1)):0)
       << ",\"incomingResumeSeconds\":" << (transition?double(transition->info.incoming_resume_frame)/transition->info.sample_rate:0)
       << ",\"outgoingEndSeconds\":" << (transition?double(transition->info.outgoing_end_frame)/transition->info.sample_rate:0);
  json << ",\"reason\":\"" << json_utils::escape(autoMixReason_) << "\",\"configRevision\":" << autoMixConfig_.revision
       << ",\"pairRevision\":" << autoMixSerial_.load(std::memory_order_acquire)
       << ",\"featuresDelivered\":" << (!autoMixOutgoingFeatures_.empty()?"true":"false")
       << ",\"stableRelease\":false,\"intelligentSkipSupported\":"
#if defined(TAE_AM_ASM) && defined(TAE_HAS_FFMPEG)
       << "true"
#else
       << "false"
#endif
       << ",\"experimentalAllowed\":";
  json<<(TAE_AM_ExperimentalPlayerAllowed()?"true":"false");
  json<<'}';
  return json.str();
}

void AudioPipeline::scheduleAutoMixLocked() {
  if (!autoMixConfig_.enabled || autoMixJob_ || !activeStream_ || !preloadStream_ || autoMixScheduledSerial_==autoMixSerial_) return;
  if(autoMixTransition_&&(autoMixOutgoingFeatures_.empty()||autoMixTransition_->phase.load(std::memory_order_acquire)!=0))return;
  reclaimAutoMixLocked();
  const auto& out = *activeStream_;
  const auto& in = *preloadStream_;
  const char* reason = nullptr;
  if (loopEnabled_.load(std::memory_order_acquire)) reason = "ab_loop";
  else if (out.item.source == in.item.source || (!out.item.id.empty() && out.item.id == in.item.id)) reason = "repeat_or_cue_boundary";
  else if (out.item.cueStartSeconds || in.item.cueStartSeconds || out.hasVirtualPregap() || in.hasVirtualPregap()) reason = "cue_boundary";
  else if (!out.item.album.empty() && out.item.album == in.item.album && out.item.artist == in.item.artist) reason = "album_boundary";
  else if (out.autoMixDurationSeconds() <= 0 || in.autoMixDurationSeconds() <= 0) reason = "known_duration_required";
  else if (out.autoMixDurationSeconds() < 10 || in.autoMixDurationSeconds() < 10) reason = "short_track";
  else if (dopPathActive_ || nativeDsdPathActive_ || pcmToDsdPathActive_ || typedPassthroughActive_) reason = "pcm_output_required";
  else if (decodeFormat_.sampleRate < 44100 || decodeFormat_.sampleRate > 192000 || decodeFormat_.channelCount < 1 || decodeFormat_.channelCount > 2 || decodeFormat_.channelCount != outputFormat_.channelCount) reason = "unsupported_format";
  else if (std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1) > kUnityVolumeEpsilon) reason = "user_playback_rate";
  else if (!publishedActiveDspGraph_ || !publishedActiveDspGraph_->supportsAutoMixSplit() || !publishedPreloadDspGraph_ || !publishedPreloadDspGraph_->supportsAutoMixSplit()) reason = "dsp_order_incompatible";
  if (reason) { autoMixReason_ = reason; return; }
  autoMixJob_ = std::make_unique<AutoMixJob>();
  autoMixJob_->outgoing = activeStream_; autoMixJob_->incoming = preloadStream_;
  autoMixJob_->outgoingDurationSeconds = out.autoMixDurationSeconds();
  autoMixJob_->incomingDurationSeconds = in.autoMixDurationSeconds();
  autoMixJob_->config = autoMixConfig_; autoMixJob_->format = decodeFormat_; autoMixJob_->dsp = dspConfig_;
  uint64_t retiredBytes=0;for(const auto& retired:retiredAutoMix_)retiredBytes+=retired->memoryBytes;
  if(autoMixTransition_)retiredBytes+=autoMixTransition_->memoryBytes;
  if(retiredBytes>=autoMixJob_->config.max_buffer_bytes) {autoMixJob_.reset();autoMixReason_="retirement_resource_limit";return;}
  autoMixJob_->config.max_buffer_bytes-=retiredBytes;
  autoMixJob_->serial = autoMixSerial_;
  autoMixJob_->planRevision=autoMixPlanRevision_;
  autoMixScheduledSerial_=autoMixJob_->serial;
  autoMixJob_->outgoingFeatures=autoMixOutgoingFeatures_;autoMixJob_->incomingFeatures=autoMixIncomingFeatures_;
  autoMixJob_->outgoingPreparationSource=autoMixOutgoingPreparationSource_;autoMixJob_->incomingPreparationSource=autoMixIncomingPreparationSource_;
  autoMixJob_->callbackFrames = std::max<size_t>(outputInfo_.bufferSizeFrames, 2048);
  // The additional continuation owns a two-second PCM ring and decoder/read
  // scratch, independently of the prepared transition. Reserve these before
  // either is allocated and retain the charge while its epoch is outstanding.
  const uint64_t continuationBytes=(std::max<uint64_t>(2ULL*decodeFormat_.sampleRate,8192)+
      kDecodeChunkFrames+autoMixJob_->callbackFrames)*decodeFormat_.channelCount*sizeof(float);
  if(continuationBytes>=autoMixJob_->config.max_buffer_bytes) {autoMixJob_.reset();autoMixReason_="transition_resource_limit";return;}
  autoMixJob_->config.max_buffer_bytes-=continuationBytes;
  autoMixReason_ = "preparing";
  autoMixWake_.notify_one();
}

void AudioPipeline::autoMixWorker() {
  for (;;) {
    std::unique_ptr<AutoMixJob> job;
    {
      std::unique_lock lock(mutex_);
      autoMixWake_.wait(lock, [this] { return autoMixShutdown_ || autoMixJob_; });
      if (autoMixShutdown_) return;
      job = std::move(autoMixJob_);
    }
    std::unique_ptr<AutoMixTransition> transition;
    std::string error,reason;
    try {
      const auto rate = static_cast<unsigned>(job->format.sampleRate);
      const auto channels = static_cast<unsigned>(job->format.channelCount);
      auto pool=twilight::automix::generateCandidates(job->config,job->outgoingDurationSeconds,job->incomingDurationSeconds,job->outgoingFeatures,job->incomingFeatures);
      if(pool.candidates.empty())throw std::runtime_error(pool.reason);
      // Independent deterministic host seed; Apple entropy/seconds rounding
      // has not been recovered. The actual UInt64 weighted selector is exact.
      unsigned maximumTier=3;
      for(;;) {
      const auto chosen=twilight::automix::selectCandidate(pool,job->serial,maximumTier);
      const auto& quality=pool.quality[chosen];
      const auto candidate=twilight::automix::candidateForRendering(pool,chosen);reason=quality.reason?quality.reason:pool.reason;
      if(quality.tier==0&&maximumTier<3)reason="intelligent_prepare_failed_conservative";
      try {
      const uint64_t outEnd=static_cast<uint64_t>(std::floor(candidate.scoring.outgoing_end*rate));
      const uint64_t outStart=static_cast<uint64_t>(std::floor(candidate.outgoing_start*rate));
      const uint64_t length=outEnd-outStart;
      if (!length || length >= outEnd) throw std::runtime_error("invalid_transition_range");
      transition = std::make_unique<AutoMixTransition>();
      transition->mixTier=quality.tier;transition->tempoRatio=quality.tempoRatio;
      transition->outgoing = job->outgoing.get(); transition->incoming = job->incoming.get();
      transition->serial = job->serial; transition->startFrame = outStart;
      TAE_AM_Plan plan=nullptr;
      if(TAE_AM_Compile(&job->config,&candidate,&plan)!=TAE_AM_OK) throw std::runtime_error("template_compile_failed");
      struct PlanGuard {TAE_AM_Plan p;~PlanGuard(){TAE_AM_DestroyPlan(p);}} guard{plan};
      TAE_AM_SourceWindowV1 windows[2]{{sizeof(TAE_AM_SourceWindowV1),TAE_AM_ABI_VERSION},{sizeof(TAE_AM_SourceWindowV1),TAE_AM_ABI_VERSION}};
      for(unsigned side=0;side<2;++side)if(TAE_AM_GetSourceWindow(plan,side,rate,&windows[side])!=TAE_AM_OK)
        throw std::runtime_error("invalid_transition_range");
      // A source may expire between authorization and preparation. Failed seek
      // or decode leaves the ordinary preload untouched.
      const auto decode = [&](const DecodeStream& source,const std::string& refreshedSource,const TAE_AM_SourceWindowV1& window) {
        const auto first=window.source_first_frame,count=window.frames;
        FFmpegDecoder decoder;
        if (!decoder.open(refreshedSource.empty()?source.item.source:refreshedSource, &error) || !decoder.setOutputFormat(job->format, &error) || !decoder.seekOutputFrame(first, &error)) throw std::runtime_error("source_not_seekable_or_expired");
        if(count*channels*sizeof(float)>job->config.max_buffer_bytes/2)throw std::runtime_error("transition_resource_limit");
        std::vector<float> pcm(count*channels);
        size_t cursor = 0;
        while (cursor < count) {
          error.clear();
          const auto read = decoder.readFrames(pcm.data()+cursor*channels, std::min<uint64_t>(2048,count-cursor), &error);
          if (!read) {
            // Preserve real following audio for the stretch lookahead. Silence
            // is valid only after confirmed EOF and after all nominal samples
            // have been decoded; a truncated/expired source still fails.
            if(error.empty()&&decoder.eof()&&first+cursor>=window.nominal_end_frame)break;
            throw std::runtime_error("transition_buffer_incomplete");
          }
          cursor += read;
        }
        // Apply each track's normalization before effects/mixing. The common
        // published graph skips it during the prepared transition.
        ReplayGainProcessor gain;
        gain.configure(job->dsp); gain.prepare(job->format); gain.setTrackContext({source.stream,source.item});
        gain.process(pcm.data(),count);
        return pcm;
      };
      auto outgoing = decode(*job->outgoing,job->outgoingPreparationSource,windows[0]);
      auto incoming = decode(*job->incoming,job->incomingPreparationSource,windows[1]);
      TAE_AM_PcmViewV1 a{sizeof a,TAE_AM_ABI_VERSION,outgoing.data(),windows[0].frames,windows[0].source_first_frame,rate,channels};
      TAE_AM_PcmViewV1 b{sizeof b,TAE_AM_ABI_VERSION,incoming.data(),windows[1].frames,windows[1].source_first_frame,rate,channels};
      const auto preparedResult=TAE_AM_Prepare(plan,&a,&b,1,1,&transition->prepared,&transition->info);
      if(preparedResult!=TAE_AM_OK)throw std::runtime_error(preparedResult==TAE_AM_RESOURCE_LIMIT?"transition_resource_limit":"transition_prepare_failed");
      if(TAE_AM_InspectPrepared(transition->prepared,&transition->mixEvidence)!=TAE_AM_OK)throw std::runtime_error("mix_evidence_unavailable");
      if(quality.tier>=2&&(transition->mixEvidence.audible_overlap_seconds<2||transition->mixEvidence.longest_overlap_seconds<1))
        throw std::runtime_error("musical_overlap_inaudible");
      transition->memoryBytes=transition->info.memory_bytes+
        (std::max<uint64_t>(2ULL*rate,8192)+kDecodeChunkFrames+job->callbackFrames)*channels*sizeof(float);
      transition->resume=makeDecodeStream();
      transition->resume->precisePcmSeek=true;
      auto continuationItem=job->incoming->item;
      if(!job->incomingPreparationSource.empty())continuationItem.source=job->incomingPreparationSource;
      if(!transition->resume->openSource(continuationItem,&error))throw std::runtime_error("resume_decoder_unavailable");
      // Refresh the decoder's authorization without changing the queue's
      // logical source identity. Promotion and subsequent host snapshots still
      // refer to the pair that authorized and analyzed this preparation.
      transition->resume->item=job->incoming->item;
      transition->resume->stream.source=job->incoming->item.source;
      if(!transition->resume->configure(job->format,double(transition->info.incoming_resume_frame)/rate,&error))throw std::runtime_error("resume_decoder_unavailable");
      transition->resume->prepareFloatReadScratch(job->callbackFrames);
      transition->resume->crossfadeConsumedFrames.store(transition->info.incoming_resume_frame,std::memory_order_release);
      transition->resume->start();
      const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);
      while(!transition->resume->readyForRender() && std::chrono::steady_clock::now()<deadline) {
        {std::lock_guard lock(mutex_);if(autoMixShutdown_||autoMixSerial_!=job->serial||autoMixPlanRevision_!=job->planRevision)break;}
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
      if(!transition->resume->readyForRender())throw std::runtime_error("resume_buffer_unavailable");
      error.clear();
      break;
      } catch(const std::exception&) {
        transition.reset();
        if(quality.tier<2)throw;
        // A prepared filter may mask one contribution. Try the next explicit
        // product tier; never promote a silent overlay to a musical-mix label.
        maximumTier=quality.tier-1;
      }
      }
    } catch(const std::exception& e) { error=e.what();transition.reset(); }
    catch(...) {error="preparation_internal_error";transition.reset();}
    {
      std::lock_guard lock(mutex_);
      if(autoMixShutdown_)return;
      if(job->serial!=autoMixSerial_ || job->planRevision!=autoMixPlanRevision_ || !autoMixConfig_.enabled || activeStream_.get()!=job->outgoing.get() || preloadStream_.get()!=job->incoming.get())continue;
      if(!transition) {autoMixReason_=autoMixTransition_?"intelligent_prepare_failed_conservative":error;continue;}
      const auto current=renderedFrames_.load(std::memory_order_acquire);
      if(current+2ULL*job->format.sampleRate>transition->startFrame) {autoMixReason_=autoMixTransition_?"intelligent_prepare_late_conservative":"preparation_deadline_missed";continue;}
      if(autoMixTransition_) {
        unsigned phase=0;
        if(!autoMixTransition_->phase.compare_exchange_strong(phase,4,std::memory_order_acq_rel))continue;
        // Withdraw before publishing the retirement epoch. A callback which
        // acquires that epoch must never subsequently load the retired pointer.
        renderAutoMix_.store(nullptr,std::memory_order_release);
        autoMixTransition_->retiredEpoch=retiredStreamEpoch_.fetch_add(1,std::memory_order_acq_rel)+1;
        retiredAutoMix_.push_back(std::move(autoMixTransition_));
      }
      autoMixTransition_=std::move(transition);
      renderAutoMixFrames_.store(0,std::memory_order_release);renderAutoMixStarted_.store(false,std::memory_order_release);
      renderAutoMix_.store(autoMixTransition_.get(),std::memory_order_release);
      autoMixReason_=reason;
    }
  }
}
