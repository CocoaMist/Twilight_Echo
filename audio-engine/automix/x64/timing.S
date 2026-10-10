/* Exact source-domain rate calculus and automation. Win64; libm is called
 * only on the preparation thread. Stack locals survive volatile XMM registers. */
.intel_syntax noprefix
.text
.globl am_rate_integral
.seh_proc am_rate_integral
am_rate_integral:
 sub rsp,88
 .seh_stackalloc 88
 .seh_endprologue
 movsd xmm1,QWORD PTR [rdx+24]
 ucomisd xmm0,xmm1
 jb .Lri_min
 movapd xmm0,xmm1
.Lri_min:
 subsd xmm0,QWORD PTR [rdx+16]
 xorpd xmm2,xmm2
 ucomisd xmm0,xmm2
 jbe .Lri_zero
 movsd QWORD PTR [rsp+48],xmm0
 movsd xmm0,QWORD PTR [rdx+40]
 subsd xmm0,QWORD PTR [rdx+32]
 movsd xmm1,QWORD PTR [rdx+24]
 subsd xmm1,QWORD PTR [rdx+16]
 divsd xmm0,xmm1
 movsd QWORD PTR [rsp+32],xmm0
 movsd xmm1,QWORD PTR [rdx+32]
 movsd QWORD PTR [rsp+40],xmm1
 movq rax,xmm0
 mov r8,0x7fffffffffffffff
 and rax,r8
 mov r8,0x7ff0000000000000
 cmp rax,r8
 jae .Lri_constant
 movq xmm2,rax
 ucomisd xmm2,QWORD PTR [rip+.Lslope_epsilon]
 jb .Lri_constant
 mulsd xmm0,QWORD PTR [rsp+48]
 addsd xmm0,xmm1
 call log
 movsd QWORD PTR [rsp+56],xmm0
 movsd xmm0,QWORD PTR [rsp+40]
 call log
 movsd xmm1,QWORD PTR [rsp+56]
 subsd xmm1,xmm0
 divsd xmm1,QWORD PTR [rsp+32]
 movapd xmm0,xmm1
 jmp .Lri_return
.Lri_constant:
 movsd xmm1,QWORD PTR [rdx+32]
 addsd xmm1,QWORD PTR [rdx+40]
 mulsd xmm1,QWORD PTR [rip+.Lhalf_t]
 movsd xmm0,QWORD PTR [rsp+48]
 divsd xmm0,xmm1
 jmp .Lri_return
.Lri_zero:
 xorpd xmm0,xmm0
.Lri_return:
 add rsp,88
 ret
.seh_endproc

.globl am_rate_inverse
.seh_proc am_rate_inverse
am_rate_inverse:
 sub rsp,88
 .seh_stackalloc 88
 .seh_endprologue
 mov QWORD PTR [rsp+64],rdx
 movsd QWORD PTR [rsp+48],xmm0
 movsd xmm0,QWORD PTR [rdx+24]
 call am_rate_integral
 movsd xmm1,QWORD PTR [rsp+48]
 ucomisd xmm1,xmm0
 jb .Linv_min
 movapd xmm1,xmm0
.Linv_min:
 movsd QWORD PTR [rsp+48],xmm1
 xorpd xmm0,xmm0
 ucomisd xmm1,xmm0
 jbe .Linv_return
 mov rdx,QWORD PTR [rsp+64]
 movsd xmm0,QWORD PTR [rdx+40]
 subsd xmm0,QWORD PTR [rdx+32]
 movsd xmm1,QWORD PTR [rdx+24]
 subsd xmm1,QWORD PTR [rdx+16]
 divsd xmm0,xmm1
 movsd QWORD PTR [rsp+32],xmm0
 movsd xmm1,QWORD PTR [rdx+32]
 movsd QWORD PTR [rsp+40],xmm1
 movq rax,xmm0
 mov r8,0x7fffffffffffffff
 and rax,r8
 mov r8,0x7ff0000000000000
 cmp rax,r8
 jae .Linv_constant
 movq xmm2,rax
 ucomisd xmm2,QWORD PTR [rip+.Lslope_epsilon]
 jb .Linv_constant
 movapd xmm0,xmm1
 call log
 movsd xmm1,QWORD PTR [rsp+32]
 mulsd xmm1,QWORD PTR [rsp+48]
 addsd xmm0,xmm1
 call exp
 subsd xmm0,QWORD PTR [rsp+40]
 divsd xmm0,QWORD PTR [rsp+32]
 jmp .Linv_return
.Linv_constant:
 movsd xmm0,QWORD PTR [rdx+32]
 addsd xmm0,QWORD PTR [rdx+40]
 mulsd xmm0,QWORD PTR [rip+.Lhalf_t]
 mulsd xmm0,QWORD PTR [rsp+48]
.Linv_return:
 add rsp,88
 ret
.seh_endproc

.globl am_curve_value
.seh_proc am_curve_value
am_curve_value:
 sub rsp,88
 .seh_stackalloc 88
 .seh_endprologue
 movsd xmm0,QWORD PTR [rcx+120]
 ucomisd xmm1,QWORD PTR [rcx+104]
 jp .Lcurve_check_range
 jae .Lcurve_return
 movsd xmm0,QWORD PTR [rcx+112]
 ucomisd xmm1,QWORD PTR [rcx+96]
 jbe .Lcurve_return
.Lcurve_check_range:
 movsd xmm2,QWORD PTR [rcx+104]
 ucomisd xmm2,QWORD PTR [rcx+96]
 jbe .Lcurve_last
 movsd xmm0,QWORD PTR [rcx+112]
 movsd xmm2,QWORD PTR [rcx+104]
 subsd xmm2,QWORD PTR [rcx+96]
 subsd xmm1,QWORD PTR [rcx+96]
 divsd xmm1,xmm2
 mov eax,DWORD PTR [rcx+128]
 mov r8d,eax
 shr r8d,6
 and eax,63
 cmp r8d,0
 je .Lcurve_in
 cmp r8d,1
 je .Lcurve_out
 jmp .Lcurve_weight
.Lcurve_in:
 test eax,eax
 jnz .Lcurve_in_power
 movsd xmm2,QWORD PTR [rip+.Lone_t]
 subsd xmm2,xmm1
 sqrtsd xmm2,xmm2
 movsd xmm1,QWORD PTR [rip+.Lone_t]
 subsd xmm1,xmm2
 jmp .Lcurve_weight
.Lcurve_in_power:
 mulsd xmm1,xmm1
 cmp eax,1
 je .Lcurve_weight
 mulsd xmm1,xmm1
 jmp .Lcurve_weight
.Lcurve_out:
 test eax,eax
 jnz .Lcurve_out_power
 sqrtsd xmm1,xmm1
 jmp .Lcurve_weight
.Lcurve_out_power:
 movsd xmm2,QWORD PTR [rip+.Lone_t]
 subsd xmm2,xmm1
 mulsd xmm2,xmm2
 cmp eax,1
 je .Lcurve_out_sub
 mulsd xmm2,xmm2
.Lcurve_out_sub:
 movsd xmm1,QWORD PTR [rip+.Lone_t]
 subsd xmm1,xmm2
.Lcurve_weight:
 cmp DWORD PTR [rcx+128],129
 je .Lcurve_log
 movsd xmm2,QWORD PTR [rcx+120]
 subsd xmm2,xmm0
 mulsd xmm2,xmm1
 addsd xmm0,xmm2
 jmp .Lcurve_return
.Lcurve_log:
 movsd QWORD PTR [rsp+48],xmm1
 movsd xmm1,QWORD PTR [rcx+120]
 movsd QWORD PTR [rsp+40],xmm1
 call log2
 movsd QWORD PTR [rsp+32],xmm0
 movsd xmm0,QWORD PTR [rsp+40]
 call log2
 subsd xmm0,QWORD PTR [rsp+32]
 mulsd xmm0,QWORD PTR [rsp+48]
 addsd xmm0,QWORD PTR [rsp+32]
 call exp2
 jmp .Lcurve_return
.Lcurve_last:
 movsd xmm0,QWORD PTR [rcx+120]
.Lcurve_return:
 add rsp,88
 ret
.seh_endproc

.globl am_playback_from_source
.seh_proc am_playback_from_source
am_playback_from_source:
 sub rsp,88
 .seh_stackalloc 88
 .seh_endprologue
 cmp DWORD PTR [rdx+72],0
 je .Lplay_linear
 ucomisd xmm0,QWORD PTR [rdx]
 jp .Lplay_mapped
 jb .Lplay_linear
.Lplay_mapped:
 mov QWORD PTR [rsp+64],rdx
 movsd QWORD PTR [rsp+48],xmm0
 movapd xmm1,xmm0
 minsd xmm1,QWORD PTR [rdx+16]
 subsd xmm1,QWORD PTR [rdx]
 xorpd xmm2,xmm2
 maxsd xmm1,xmm2
 divsd xmm1,QWORD PTR [rdx+32]
 addsd xmm1,QWORD PTR [rdx+48]
 movsd QWORD PTR [rsp+40],xmm1
 call am_rate_integral
 addsd xmm0,QWORD PTR [rsp+40]
 mov rdx,QWORD PTR [rsp+64]
 movsd xmm1,QWORD PTR [rsp+48]
 subsd xmm1,QWORD PTR [rdx+24]
 xorpd xmm2,xmm2
 maxsd xmm1,xmm2
 divsd xmm1,QWORD PTR [rdx+40]
 addsd xmm0,xmm1
 jmp .Lplay_return
.Lplay_linear:
 movsd xmm1,QWORD PTR [rdx+48]
 addsd xmm1,xmm0
 subsd xmm1,QWORD PTR [rdx]
 movapd xmm0,xmm1
.Lplay_return:
 add rsp,88
 ret
.seh_endproc

.globl am_source_from_playback
.seh_proc am_source_from_playback
am_source_from_playback:
 sub rsp,104
 .seh_stackalloc 104
 .seh_endprologue
 subsd xmm0,QWORD PTR [rdx+48]
 cmp DWORD PTR [rdx+72],0
 je .Lsource_linear
 xorpd xmm1,xmm1
 ucomisd xmm0,xmm1
 jp .Lsource_mapped
 jb .Lsource_linear
.Lsource_mapped:
 mov QWORD PTR [rsp+80],rdx
 movsd QWORD PTR [rsp+48],xmm0
 movsd xmm0,QWORD PTR [rdx+16]
 call am_playback_from_source
 mov rdx,QWORD PTR [rsp+80]
 subsd xmm0,QWORD PTR [rdx+48]
 movsd QWORD PTR [rsp+56],xmm0
 movsd xmm0,QWORD PTR [rdx+24]
 call am_playback_from_source
 mov rdx,QWORD PTR [rsp+80]
 subsd xmm0,QWORD PTR [rdx+48]
 movsd QWORD PTR [rsp+64],xmm0
 movsd xmm0,QWORD PTR [rsp+48]
 subsd xmm0,QWORD PTR [rsp+56]
 call am_rate_inverse
 movsd QWORD PTR [rsp+72],xmm0
 mov rdx,QWORD PTR [rsp+80]
 movsd xmm1,QWORD PTR [rsp+48]
 minsd xmm1,QWORD PTR [rsp+56]
 xorpd xmm2,xmm2
 maxsd xmm1,xmm2
 mulsd xmm1,QWORD PTR [rdx+32]
 addsd xmm1,QWORD PTR [rdx]
 addsd xmm1,QWORD PTR [rsp+72]
 movsd xmm0,QWORD PTR [rsp+48]
 subsd xmm0,QWORD PTR [rsp+64]
 maxsd xmm0,xmm2
 mulsd xmm0,QWORD PTR [rdx+40]
 addsd xmm0,xmm1
 jmp .Lsource_return
.Lsource_linear:
 addsd xmm0,QWORD PTR [rdx]
.Lsource_return:
 add rsp,104
 ret
.seh_endproc
.section .rdata,"dr"
.p2align 3
.Lone_t: .double 1
.Lhalf_t: .double 0.5
.Lslope_epsilon: .double 0.000001
